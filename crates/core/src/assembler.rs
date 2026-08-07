//! Sequential shard assembler: append complete single-shard PDFs, then
//! finalize into one document with a rebuilt page tree and a merged
//! named-destination tree.
//!
//! Boundary (per design spec): structure only — page tree, destinations,
//! (later) outlines and patch tables. Content streams are never rewritten.
//!
//! v0 correctness-first limitation: the output document accumulates in memory
//! and is serialized at finalize. The streaming writer (working set = one
//! shard) replaces this before any memory-ceiling claim is made.

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, StringFormat};
use std::fmt;
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, AssemblyError>;

#[derive(Debug)]
pub enum AssemblyError {
    Pdf(lopdf::Error),
    Io(std::io::Error),
    Malformed(String),
}

impl fmt::Display for AssemblyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AssemblyError::Pdf(e) => write!(f, "pdf error: {e}"),
            AssemblyError::Io(e) => write!(f, "io error: {e}"),
            AssemblyError::Malformed(msg) => write!(f, "malformed shard: {msg}"),
        }
    }
}

impl std::error::Error for AssemblyError {}

impl From<lopdf::Error> for AssemblyError {
    fn from(e: lopdf::Error) -> Self {
        AssemblyError::Pdf(e)
    }
}

impl From<std::io::Error> for AssemblyError {
    fn from(e: std::io::Error) -> Self {
        AssemblyError::Io(e)
    }
}

/// Page-tree attributes that children inherit; must be pushed down onto each
/// page before its original parent chain is discarded.
const INHERITABLE_PAGE_KEYS: [&[u8]; 4] =
    [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

pub struct Assembly {
    output_path: PathBuf,
    doc: Document,
    page_ids: Vec<ObjectId>,
    named_dests: Vec<(Vec<u8>, Object)>,
}

impl Assembly {
    pub fn new(output_path: impl Into<PathBuf>) -> Self {
        Assembly {
            output_path: output_path.into(),
            doc: Document::with_version("1.7"),
            page_ids: Vec::new(),
            named_dests: Vec::new(),
        }
    }

    pub fn append_shard_file(&mut self, path: &Path) -> Result<u32> {
        let shard = Document::load(path)?;
        self.append_shard_doc(shard)
    }

    /// Grafts a shard's pages (and every object they reach) into the growing
    /// document. Returns the shard's page count.
    pub fn append_shard_doc(&mut self, mut shard: Document) -> Result<u32> {
        shard.renumber_objects_with(self.doc.max_id + 1);

        let pages: Vec<ObjectId> = shard.get_pages().into_values().collect();
        if pages.is_empty() {
            return Err(AssemblyError::Malformed("shard has no pages".into()));
        }

        push_down_inherited(&mut shard, &pages)?;
        let dests = extract_named_dests(&shard)?;

        // The shard's own catalog and page-tree root are replaced by ours;
        // drop them so finalize's prune has nothing dangling to keep.
        let root_id = trailer_root(&shard)?;
        let pages_root = shard
            .get_object(root_id)?
            .as_dict()?
            .get(b"Pages")?
            .as_reference()?;
        shard.objects.remove(&root_id);
        shard.objects.remove(&pages_root);

        let count = pages.len() as u32;
        if shard.max_id > self.doc.max_id {
            self.doc.max_id = shard.max_id;
        }
        self.doc.objects.extend(shard.objects);
        self.page_ids.extend(pages);
        self.named_dests.extend(dests);
        Ok(count)
    }

    pub fn page_count(&self) -> usize {
        self.page_ids.len()
    }

    /// Builds the unified page tree + merged name tree, writes the document.
    pub fn finalize(mut self) -> Result<()> {
        let pages_id = self.doc.new_object_id();
        for &pid in &self.page_ids {
            let page = self.doc.get_object_mut(pid)?.as_dict_mut()?;
            page.set("Parent", Object::Reference(pages_id));
        }
        let kids: Vec<Object> =
            self.page_ids.iter().map(|&id| Object::Reference(id)).collect();
        self.doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Count" => self.page_ids.len() as i64,
                "Kids" => kids,
            }),
        );

        let mut catalog = dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        };
        if !self.named_dests.is_empty() {
            self.named_dests.sort_by(|a, b| a.0.cmp(&b.0));
            let mut names: Vec<Object> =
                Vec::with_capacity(self.named_dests.len() * 2);
            for (name, dest) in std::mem::take(&mut self.named_dests) {
                names.push(Object::String(name, StringFormat::Literal));
                names.push(dest);
            }
            catalog.set(
                "Names",
                Object::Dictionary(dictionary! {
                    "Dests" => Object::Dictionary(dictionary! { "Names" => names }),
                }),
            );
        }
        let catalog_id = self.doc.add_object(catalog);
        self.doc.trailer.set("Root", Object::Reference(catalog_id));

        self.doc.prune_objects(); // orphaned shard structures (old name trees…)
        self.doc.compress();
        self.doc.save(&self.output_path)?;
        Ok(())
    }
}

fn trailer_root(doc: &Document) -> Result<ObjectId> {
    Ok(doc.trailer.get(b"Root")?.as_reference()?)
}

/// Follows references (bounded, cycles are malformed input) to a concrete object.
fn resolve<'a>(doc: &'a Document, mut obj: &'a Object) -> Result<&'a Object> {
    for _ in 0..32 {
        match obj {
            Object::Reference(id) => obj = doc.get_object(*id)?,
            other => return Ok(other),
        }
    }
    Err(AssemblyError::Malformed("reference chain too deep".into()))
}

fn resolve_dict<'a>(doc: &'a Document, obj: &'a Object) -> Result<&'a Dictionary> {
    Ok(resolve(doc, obj)?.as_dict()?)
}

/// Copies inheritable page-tree attributes onto each page that lacks them,
/// so pages stay correct after their original parent chain is dropped.
fn push_down_inherited(shard: &mut Document, pages: &[ObjectId]) -> Result<()> {
    for &pid in pages {
        let mut inherited: Vec<(&[u8], Object)> = Vec::new();
        {
            let page = shard.get_object(pid)?.as_dict()?;
            let mut missing: Vec<&[u8]> = INHERITABLE_PAGE_KEYS
                .into_iter()
                .filter(|key| !page.has(key))
                .collect();
            let mut current = page;
            while !missing.is_empty() {
                let Ok(parent) = current.get(b"Parent") else { break };
                current = resolve_dict(shard, parent)?;
                missing.retain(|key| {
                    if let Ok(value) = current.get(key) {
                        inherited.push((key, value.clone()));
                        false
                    } else {
                        true
                    }
                });
            }
        }
        if !inherited.is_empty() {
            let page = shard.get_object_mut(pid)?.as_dict_mut()?;
            for (key, value) in inherited {
                page.set(key, value);
            }
        }
    }
    Ok(())
}

/// Collects (name, destination) pairs from the shard's catalog — both the
/// /Names/Dests name tree (PDF 1.2+) and the legacy /Dests dictionary.
fn extract_named_dests(shard: &Document) -> Result<Vec<(Vec<u8>, Object)>> {
    let mut out = Vec::new();
    let catalog = shard.get_object(trailer_root(shard)?)?.as_dict()?;

    if let Ok(names_obj) = catalog.get(b"Names") {
        let names_dict = resolve_dict(shard, names_obj)?;
        if let Ok(dests_obj) = names_dict.get(b"Dests") {
            walk_name_tree(shard, dests_obj, &mut out)?;
        }
    }
    if let Ok(dests_obj) = catalog.get(b"Dests") {
        let legacy = resolve_dict(shard, dests_obj)?;
        for (name, dest) in legacy.iter() {
            out.push((name.clone(), dest.clone()));
        }
    }
    Ok(out)
}

fn walk_name_tree(
    doc: &Document,
    node_obj: &Object,
    out: &mut Vec<(Vec<u8>, Object)>,
) -> Result<()> {
    let node = resolve_dict(doc, node_obj)?;
    if let Ok(kids_obj) = node.get(b"Kids") {
        for kid in resolve(doc, kids_obj)?.as_array()? {
            walk_name_tree(doc, kid, out)?;
        }
    }
    if let Ok(names_obj) = node.get(b"Names") {
        let names = resolve(doc, names_obj)?.as_array()?;
        for pair in names.chunks(2) {
            let [name_obj, dest] = pair else {
                return Err(AssemblyError::Malformed(
                    "odd-length /Names array".into(),
                ));
            };
            let name = resolve(doc, name_obj)?.as_str()?;
            out.push((name.to_vec(), dest.clone()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Stream;

    /// Minimal but complete shard: n pages of Courier text, inheritable
    /// attributes ONLY on the pages node (exercises push-down), and a named
    /// destination per page in a /Names/Dests tree.
    fn make_shard(page_count: usize, tag: &str) -> Document {
        let mut doc = Document::with_version("1.7");
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier",
        });
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();
        let mut page_ids = Vec::new();
        for i in 0..page_count {
            let content = format!("BT /F1 12 Tf 72 720 Td ({tag}-p{i}) Tj ET");
            let stream_id = doc.add_object(Object::Stream(Stream::new(
                dictionary! {},
                content.into_bytes(),
            )));
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => Object::Reference(pages_id),
                "Contents" => Object::Reference(stream_id),
            });
            kids.push(Object::Reference(page_id));
            page_ids.push(page_id);
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Count" => page_count as i64,
                "Kids" => kids,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Resources" => dictionary! {
                    "Font" => dictionary! { "F1" => Object::Reference(font_id) },
                },
            }),
        );
        let mut names = Vec::new();
        for (i, pid) in page_ids.iter().enumerate() {
            names.push(Object::string_literal(format!("{tag}-p{i}")));
            names.push(Object::Array(vec![
                Object::Reference(*pid),
                "XYZ".into(),
                Object::Null,
                Object::Null,
                Object::Null,
            ]));
        }
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
            "Names" => dictionary! {
                "Dests" => dictionary! { "Names" => Object::Array(names) },
            },
        });
        doc.trailer.set("Root", Object::Reference(catalog_id));
        doc
    }

    fn assemble(shards: Vec<Document>, name: &str) -> Document {
        let out = std::env::temp_dir().join(format!("shardpdf-core-test-{name}.pdf"));
        let mut assembly = Assembly::new(&out);
        for shard in shards {
            assembly.append_shard_doc(shard).unwrap();
        }
        assembly.finalize().unwrap();
        let merged = Document::load(&out).unwrap();
        std::fs::remove_file(&out).ok();
        merged
    }

    fn page_text(doc: &Document, page_id: ObjectId) -> String {
        let contents = doc
            .get_object(page_id)
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Contents")
            .unwrap()
            .as_reference()
            .unwrap();
        let stream = doc.get_object(contents).unwrap().as_stream().unwrap();
        let data = stream
            .decompressed_content()
            .unwrap_or_else(|_| stream.content.clone());
        String::from_utf8_lossy(&data).into_owned()
    }

    #[test]
    fn merges_pages_in_shard_order() {
        let merged = assemble(vec![make_shard(2, "a"), make_shard(3, "b")], "order");
        let pages: Vec<ObjectId> = merged.get_pages().into_values().collect();
        assert_eq!(pages.len(), 5);
        let expected = ["a-p0", "a-p1", "b-p0", "b-p1", "b-p2"];
        for (page_id, want) in pages.iter().zip(expected) {
            assert!(
                page_text(&merged, *page_id).contains(want),
                "expected page containing {want}"
            );
        }
    }

    #[test]
    fn page_counts_are_additive_for_arbitrary_splits() {
        for split in [vec![1usize], vec![1, 1, 1, 1], vec![4, 1, 7], vec![3, 3]] {
            let shards: Vec<Document> = split
                .iter()
                .enumerate()
                .map(|(i, &n)| make_shard(n, &format!("s{i}")))
                .collect();
            let merged = assemble(shards, &format!("split-{split:?}"));
            assert_eq!(merged.get_pages().len(), split.iter().sum::<usize>());
        }
    }

    #[test]
    fn pushes_inherited_attributes_onto_pages() {
        let merged = assemble(vec![make_shard(2, "inh")], "inherit");
        for page_id in merged.get_pages().into_values() {
            let page = merged.get_object(page_id).unwrap().as_dict().unwrap();
            assert!(page.has(b"MediaBox"), "page lost inherited MediaBox");
            assert!(page.has(b"Resources"), "page lost inherited Resources");
        }
    }

    #[test]
    fn named_destinations_survive_merge_across_shards() {
        let merged = assemble(vec![make_shard(2, "x"), make_shard(2, "y")], "dests");
        let catalog = merged
            .get_object(merged.trailer.get(b"Root").unwrap().as_reference().unwrap())
            .unwrap()
            .as_dict()
            .unwrap();
        let mut found = Vec::new();
        let names_obj = catalog.get(b"Names").expect("catalog lost /Names");
        let names_dict = resolve_dict(&merged, names_obj).unwrap();
        walk_name_tree(&merged, names_dict.get(b"Dests").unwrap(), &mut found)
            .unwrap();

        let names: Vec<String> = found
            .iter()
            .map(|(n, _)| String::from_utf8_lossy(n).into_owned())
            .collect();
        assert_eq!(names, ["x-p0", "x-p1", "y-p0", "y-p1"], "sorted, complete");

        for (name, dest) in &found {
            let dest = resolve(&merged, dest).unwrap().as_array().unwrap();
            let target = dest[0].as_reference().unwrap();
            let target_type = merged
                .get_object(target)
                .unwrap()
                .as_dict()
                .unwrap()
                .get(b"Type")
                .unwrap()
                .as_name()
                .unwrap();
            assert_eq!(
                target_type, b"Page",
                "dest {} points at a non-page",
                String::from_utf8_lossy(name)
            );
        }
    }

    #[test]
    fn empty_shard_is_rejected() {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.add_object(dictionary! {
            "Type" => "Pages", "Count" => 0, "Kids" => Vec::<Object>::new(),
        });
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => Object::Reference(pages_id),
        });
        doc.trailer.set("Root", Object::Reference(catalog_id));

        let out = std::env::temp_dir().join("shardpdf-core-test-empty.pdf");
        let mut assembly = Assembly::new(&out);
        assert!(matches!(
            assembly.append_shard_doc(doc),
            Err(AssemblyError::Malformed(_))
        ));
    }
}
