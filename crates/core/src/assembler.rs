//! Streaming shard assembler: append complete single-shard PDFs, then
//! finalize into one document with a rebuilt page tree and a merged
//! named-destination tree.
//!
//! Boundary (per design spec): structure only — page tree, destinations,
//! outlines and (later) patch tables. Content streams are never rewritten.
//!
//! Memory model: object ids 1 (Pages) and 2 (Catalog) are reserved up front,
//! so every shard object streams to disk the moment its shard is parsed and
//! the shard is dropped before the next loads. The working set is one parsed
//! shard plus O(pages + destinations) bookkeeping (byte offsets, page ids,
//! dest names) — the `O(largest shard) + O(page-tree/outline metadata)`
//! formula the spec promises. Shard catalogs/page-tree roots are written as
//! unreachable orphan objects (bytes over bookkeeping: keeping ids dense
//! beats re-walking shards to drop a few small dicts).

use crate::outline::{build_outline_objects, OutlineEntry};
use crate::serializer::write_indirect_object;
use lopdf::{dictionary, Dictionary, Document, LoadOptions, Object, ObjectId, StringFormat};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, AssemblyError>;

#[derive(Debug)]
pub enum AssemblyError {
    Pdf(lopdf::Error),
    Io(std::io::Error),
    Malformed(String),
    /// A page selection was rejected: empty, duplicated, or out of range
    /// for the document. A caller bug, not a property of the input PDF.
    InvalidSelection(String),
    /// An outline supplied by the caller was rejected: empty, a level jump,
    /// or a page index past the assembled document. A caller bug, not a
    /// property of the input PDFs.
    InvalidOutline(String),
}

impl fmt::Display for AssemblyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AssemblyError::Pdf(e) => write!(f, "pdf error: {e}"),
            AssemblyError::Io(e) => write!(f, "io error: {e}"),
            AssemblyError::Malformed(msg) => write!(f, "malformed shard: {msg}"),
            AssemblyError::InvalidSelection(msg) => write!(f, "invalid page selection: {msg}"),
            AssemblyError::InvalidOutline(msg) => write!(f, "invalid outline: {msg}"),
        }
    }
}

impl std::error::Error for AssemblyError {}

impl From<lopdf::Error> for AssemblyError {
    fn from(e: lopdf::Error) -> Self {
        // lopdf wraps filesystem failures (missing input file, permission
        // denied) in its own error type. Callers need to tell "file not
        // there" from "file is not a PDF", so unwrap IO back out.
        match e {
            lopdf::Error::IO(io) => AssemblyError::Io(io),
            other => AssemblyError::Pdf(other),
        }
    }
}

impl From<std::io::Error> for AssemblyError {
    fn from(e: std::io::Error) -> Self {
        AssemblyError::Io(e)
    }
}

const PAGES_ID: ObjectId = (1, 0);
const CATALOG_ID: ObjectId = (2, 0);
const FIRST_SHARD_OBJECT: u32 = 3;

/// Page-tree attributes that children inherit; must be pushed down onto each
/// page because the final tree is flat (single Pages parent, no attributes).
const INHERITABLE_PAGE_KEYS: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

struct CountingWriter {
    inner: BufWriter<File>,
    position: u64,
}

impl CountingWriter {
    fn new(file: File) -> Self {
        CountingWriter {
            inner: BufWriter::new(file),
            position: 0,
        }
    }
}

impl Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.position += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Options for parsing shards. Defaults are lenient and unbounded, which is
/// right for shards the caller rendered itself.
#[derive(Debug, Clone, Default)]
pub struct ShardLoadOptions {
    /// Upper bound on how many bytes any one compressed stream in a shard
    /// may inflate to while the shard is parsed. lopdf decodes object and
    /// xref streams eagerly on load, so without a bound a sub-kilobyte file
    /// can allocate gigabytes before this crate sees it. `None` = no limit.
    pub max_decompressed_bytes: Option<usize>,
}

impl ShardLoadOptions {
    fn to_lopdf(&self) -> LoadOptions {
        LoadOptions {
            max_decompressed_size: self.max_decompressed_bytes,
            ..LoadOptions::default()
        }
    }
}

/// Loads a PDF from disk with the given shard options.
pub fn load_document(path: &Path, options: &ShardLoadOptions) -> Result<Document> {
    Ok(Document::load_with_options(path, options.to_lopdf())?)
}

/// Parses a PDF already held in memory with the given shard options.
pub fn load_document_bytes(bytes: &[u8], options: &ShardLoadOptions) -> Result<Document> {
    Ok(Document::load_mem_with_options(bytes, options.to_lopdf())?)
}

/// Where a PDF comes from: a path on disk or bytes already in memory. Both
/// parse through the same lopdf options, so a document behaves identically
/// whichever way it arrives.
#[derive(Debug, Clone, Copy)]
pub enum PdfSource<'a> {
    Path(&'a Path),
    Bytes(&'a [u8]),
}

impl<'a> From<&'a Path> for PdfSource<'a> {
    fn from(path: &'a Path) -> Self {
        PdfSource::Path(path)
    }
}

impl<'a> From<&'a [u8]> for PdfSource<'a> {
    fn from(bytes: &'a [u8]) -> Self {
        PdfSource::Bytes(bytes)
    }
}

/// Loads a PDF from either source with the given shard options.
pub fn load_source(source: PdfSource<'_>, options: &ShardLoadOptions) -> Result<Document> {
    match source {
        PdfSource::Path(path) => load_document(path, options),
        PdfSource::Bytes(bytes) => load_document_bytes(bytes, options),
    }
}

/// Parses the source and returns its page count. Nothing is built or
/// written; the working set is one parsed document.
pub fn page_count(source: PdfSource<'_>, options: &ShardLoadOptions) -> Result<usize> {
    Ok(load_source(source, options)?.get_pages().len())
}

pub struct Assembly {
    output_path: PathBuf,
    load_options: ShardLoadOptions,
    writer: CountingWriter,
    /// object number -> byte offset of its `n g obj` header
    offsets: BTreeMap<u32, u64>,
    page_ids: Vec<ObjectId>,
    named_dests: Vec<(Vec<u8>, Object)>,
    next_object: u32,
}

impl Assembly {
    pub fn new(output_path: impl Into<PathBuf>) -> Result<Self> {
        Self::with_options(output_path, ShardLoadOptions::default())
    }

    pub fn with_options(
        output_path: impl Into<PathBuf>,
        load_options: ShardLoadOptions,
    ) -> Result<Self> {
        let output_path = output_path.into();
        let mut writer = CountingWriter::new(File::create(&output_path)?);
        // Header + high-bit comment marking the file as binary (spec §7.5.2).
        writer.write_all(b"%PDF-1.7\n%\xB5\xB5\xB5\xB5\n")?;
        Ok(Assembly {
            output_path,
            load_options,
            writer,
            offsets: BTreeMap::new(),
            page_ids: Vec::new(),
            named_dests: Vec::new(),
            next_object: FIRST_SHARD_OBJECT,
        })
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }

    pub fn append_shard_file(&mut self, path: &Path) -> Result<u32> {
        let shard = load_document(path, &self.load_options)?;
        self.append_shard_doc(shard)
    }

    /// Same as [`append_shard_file`](Self::append_shard_file) but parses the
    /// shard from memory. The caller's buffer is not retained.
    pub fn append_shard_bytes(&mut self, bytes: &[u8]) -> Result<u32> {
        let shard = load_document_bytes(bytes, &self.load_options)?;
        self.append_shard_doc(shard)
    }

    /// Streams a shard's objects into the output file. The shard is fully
    /// consumed; nothing of it stays in memory beyond page ids, destination
    /// names, and byte offsets.
    pub fn append_shard_doc(&mut self, mut shard: Document) -> Result<u32> {
        // lopdf keeps the source's object-stream containers and xref streams
        // in `objects` (it has already unpacked their contents). Copying them
        // would duplicate every packed object as an orphan blob and drop a
        // stray /Type /XRef stream into the output. Drop them before
        // renumbering so the id space stays dense.
        shard
            .objects
            .retain(|_, object| !is_structural_only(object));
        shard.renumber_objects_with(self.next_object);
        normalize_generations(&mut shard);

        let pages: Vec<ObjectId> = shard.get_pages().into_values().collect();
        if pages.is_empty() {
            return Err(AssemblyError::Malformed("shard has no pages".into()));
        }

        push_down_inherited(&mut shard, &pages)?;
        let dests = extract_named_dests(&shard)?;

        for &pid in &pages {
            let page = shard.get_object_mut(pid)?.as_dict_mut()?;
            page.set("Parent", Object::Reference(PAGES_ID));
        }

        for (&id, object) in &shard.objects {
            debug_assert_eq!(id.1, 0, "generations are normalized before writing");
            self.offsets.insert(id.0, self.writer.position);
            write_indirect_object(&mut self.writer, id, object)?;
        }

        self.next_object = shard.max_id + 1;
        let count = pages.len() as u32;
        self.page_ids.extend(pages);
        self.named_dests.extend(dests);
        Ok(count)
    }

    pub fn page_count(&self) -> usize {
        self.page_ids.len()
    }

    /// Writes the unified page tree, optional /Outlines tree, catalog (with
    /// merged name tree), xref table and trailer. Consumes the assembly.
    pub fn finalize(mut self, outline: Option<&[OutlineEntry]>) -> Result<()> {
        self.named_dests.sort_by(|a, b| a.0.cmp(&b.0));
        if let Some(duplicate) = self
            .named_dests
            .windows(2)
            .find(|pair| pair[0].0 == pair[1].0)
        {
            return Err(AssemblyError::Malformed(format!(
                "duplicate named destination {:?}",
                String::from_utf8_lossy(&duplicate[0].0)
            )));
        }

        let pages = Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Count" => self.page_ids.len() as i64,
            "Kids" => self
                .page_ids
                .iter()
                .map(|&id| Object::Reference(id))
                .collect::<Vec<Object>>(),
        });
        self.offsets.insert(PAGES_ID.0, self.writer.position);
        write_indirect_object(&mut self.writer, PAGES_ID, &pages)?;

        let mut catalog = dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(PAGES_ID),
        };
        if let Some(entries) = outline.filter(|entries| !entries.is_empty()) {
            let mut next = self.next_object;
            let mut alloc = || {
                let id = (next, 0);
                next += 1;
                id
            };
            let (root_id, objects) = build_outline_objects(entries, &self.page_ids, &mut alloc)?;
            for (id, object) in &objects {
                self.offsets.insert(id.0, self.writer.position);
                write_indirect_object(&mut self.writer, *id, object)?;
            }
            self.next_object = next;
            catalog.set("Outlines", Object::Reference(root_id));
            catalog.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
        }
        if !self.named_dests.is_empty() {
            let mut names: Vec<Object> = Vec::with_capacity(self.named_dests.len() * 2);
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
        self.offsets.insert(CATALOG_ID.0, self.writer.position);
        write_indirect_object(&mut self.writer, CATALOG_ID, &Object::Dictionary(catalog))?;

        let size = self.next_object;
        for number in 1..size {
            if !self.offsets.contains_key(&number) {
                return Err(AssemblyError::Malformed(format!(
                    "xref gap at object {number}: shard renumbering not dense"
                )));
            }
        }

        let xref_start = self.writer.position;
        writeln!(self.writer, "xref\n0 {size}")?;
        self.writer.write_all(b"0000000000 65535 f \n")?;
        for offset in self.offsets.values() {
            self.writer
                .write_all(format!("{offset:010} 00000 n \n").as_bytes())?;
        }
        write!(
            self.writer,
            "trailer\n<< /Size {size} /Root {} {} R >>\nstartxref\n{xref_start}\n%%EOF\n",
            CATALOG_ID.0, CATALOG_ID.1
        )?;
        self.writer.flush()?;
        Ok(())
    }
}

fn trailer_root(doc: &Document) -> Result<ObjectId> {
    Ok(doc.trailer.get(b"Root")?.as_reference()?)
}

/// Objects that only describe the *source file's* layout and must never be
/// carried into a re-serialized document: object-stream containers, xref
/// streams, and the linearization dictionary.
fn is_structural_only(object: &Object) -> bool {
    match object {
        Object::Stream(stream) => stream.dict.has_type(b"ObjStm") || stream.dict.has_type(b"XRef"),
        Object::Dictionary(dict) => dict.has(b"Linearized"),
        _ => false,
    }
}

/// Rewrites every object id and reference to generation 0. Renumbering keeps
/// the source generation (`5 2 obj` after an incremental update), but the
/// xref table this assembler writes is a fresh, single-section table, so a
/// non-zero generation there would contradict the object header and produce
/// a document strict readers reject. Numbers are already unique after
/// renumbering, so collapsing generations cannot collide.
fn normalize_generations(shard: &mut Document) {
    if shard.objects.keys().all(|id| id.1 == 0) {
        return;
    }
    let objects = std::mem::take(&mut shard.objects);
    shard.objects = objects
        .into_iter()
        .map(|((number, _), object)| ((number, 0), object))
        .collect();
    shard.traverse_objects(|object| {
        if let Object::Reference((_, generation)) = object {
            *generation = 0;
        }
    });
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
/// so pages stay correct after their original parent chain is discarded.
pub(crate) fn push_down_inherited(shard: &mut Document, pages: &[ObjectId]) -> Result<()> {
    for &pid in pages {
        let mut inherited: Vec<(&[u8], Object)> = Vec::new();
        {
            let page = shard.get_object(pid)?.as_dict()?;
            let mut missing: Vec<&[u8]> = INHERITABLE_PAGE_KEYS
                .into_iter()
                .filter(|key| !page.has(key))
                .collect();
            let mut current = page;
            let mut ancestors = BTreeSet::from([pid]);
            while !missing.is_empty() {
                let Ok(parent) = current.get(b"Parent") else {
                    break;
                };
                if let Object::Reference(parent_id) = parent {
                    if !ancestors.insert(*parent_id) {
                        return Err(AssemblyError::Malformed(format!(
                            "cycle in /Parent chain for page {} {} R",
                            pid.0, pid.1
                        )));
                    }
                }
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
            walk_name_tree(shard, dests_obj, &mut out, &mut BTreeSet::new())?;
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
    visited: &mut BTreeSet<ObjectId>,
) -> Result<()> {
    if let Object::Reference(id) = node_obj {
        if !visited.insert(*id) {
            return Err(AssemblyError::Malformed(format!(
                "cycle in /Names/Dests tree at {} {} R",
                id.0, id.1
            )));
        }
    }
    let node = resolve_dict(doc, node_obj)?;
    if let Ok(kids_obj) = node.get(b"Kids") {
        for kid in resolve(doc, kids_obj)?.as_array()? {
            walk_name_tree(doc, kid, out, visited)?;
        }
    }
    if let Ok(names_obj) = node.get(b"Names") {
        let names = resolve(doc, names_obj)?.as_array()?;
        for pair in names.chunks(2) {
            let [name_obj, dest] = pair else {
                return Err(AssemblyError::Malformed("odd-length /Names array".into()));
            };
            let name = resolve(doc, name_obj)?.as_str()?;
            out.push((name.to_vec(), dest.clone()));
        }
    }
    Ok(())
}

/// Shared fixtures for this module's tests and cross-module tests (extract).
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use lopdf::Stream;

    /// Minimal but complete shard: n pages of Courier text, inheritable
    /// attributes ONLY on the pages node (exercises push-down), and a named
    /// destination per page in a /Names/Dests tree.
    pub(crate) fn make_shard(page_count: usize, tag: &str) -> Document {
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

    /// Assemble shards into `out`, leaving the file on disk for the caller.
    pub(crate) fn assemble_to(shards: Vec<Document>, out: &std::path::Path) {
        let mut assembly = Assembly::new(out).unwrap();
        for shard in shards {
            assembly.append_shard_doc(shard).unwrap();
        }
        assembly.finalize(None).unwrap();
    }

    pub(crate) fn page_text(doc: &Document, page_id: ObjectId) -> String {
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
}

#[cfg(test)]
mod tests {
    use super::test_support::{assemble_to, make_shard, page_text};
    use super::*;

    fn assemble(shards: Vec<Document>, name: &str) -> Document {
        let out = std::env::temp_dir().join(format!("shardpdf-core-test-{name}.pdf"));
        assemble_to(shards, &out);
        let merged = Document::load(&out).unwrap();
        std::fs::remove_file(&out).ok();
        merged
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
        walk_name_tree(
            &merged,
            names_dict.get(b"Dests").unwrap(),
            &mut found,
            &mut BTreeSet::new(),
        )
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
                target_type,
                b"Page",
                "dest {} points at a non-page",
                String::from_utf8_lossy(name)
            );
        }
    }

    #[test]
    fn duplicate_named_destinations_are_rejected() {
        let out = std::env::temp_dir().join("shardpdf-core-test-duplicate-dest.pdf");
        let mut assembly = Assembly::new(&out).unwrap();
        assembly.append_shard_doc(make_shard(1, "dup")).unwrap();
        assembly.append_shard_doc(make_shard(1, "dup")).unwrap();
        let result = assembly.finalize(None);
        std::fs::remove_file(&out).ok();

        assert!(matches!(
            result,
            Err(AssemblyError::Malformed(message))
                if message.contains("duplicate named destination")
        ));
    }

    /// CI-friendly cousin of the cargo-fuzz harness: mutated/truncated valid
    /// shards must produce Ok or Err — never a panic. (A panic fails the
    /// test; that IS the assertion.)
    #[test]
    fn mutated_shards_never_panic() {
        let mut bytes = Vec::new();
        make_shard(3, "fz").save_to(&mut bytes).unwrap();

        let mut seed = 0x5eed_ba5eu32;
        let mut rand = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            seed
        };

        for round in 0..300 {
            let mut mutated = bytes.clone();
            match round % 3 {
                0 => {
                    let cut = rand() as usize % mutated.len();
                    mutated.truncate(cut.max(1));
                }
                1 => {
                    for _ in 0..1 + rand() % 8 {
                        let at = rand() as usize % mutated.len();
                        mutated[at] = (rand() & 0xff) as u8;
                    }
                }
                _ => {
                    let at = rand() as usize % mutated.len();
                    let len = (rand() as usize % 64).min(mutated.len() - at);
                    mutated.drain(at..at + len);
                }
            }

            let Ok(doc) = Document::load_mem(&mutated) else {
                continue;
            };
            let out = std::env::temp_dir().join(format!("shardpdf-mut-{round}.pdf"));
            if let Ok(mut assembly) = Assembly::new(&out) {
                let appended = assembly.append_shard_doc(doc);
                if appended.is_ok() {
                    let _ = assembly.finalize(None);
                }
            }
            std::fs::remove_file(&out).ok();
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
        let mut assembly = Assembly::new(&out).unwrap();
        assert!(matches!(
            assembly.append_shard_doc(doc),
            Err(AssemblyError::Malformed(_))
        ));
        drop(assembly);
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn cyclic_page_parent_is_rejected() {
        let out = std::env::temp_dir().join("shardpdf-core-test-parent-cycle.pdf");
        let mut doc = make_shard(1, "cycle");
        let page_id = *doc.get_pages().values().next().unwrap();
        doc.get_object_mut(page_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Parent", Object::Reference(page_id));

        let mut assembly = Assembly::new(&out).unwrap();
        let result = assembly.append_shard_doc(doc);
        std::fs::remove_file(&out).ok();
        assert!(matches!(
            result,
            Err(AssemblyError::Malformed(message)) if message.contains("cycle in /Parent chain")
        ));
    }

    /// A /Names/Dests node whose /Kids points back at itself must be
    /// rejected, not recursed into until the stack overflows.
    #[test]
    fn cyclic_name_tree_is_rejected() {
        let out = std::env::temp_dir().join("shardpdf-core-test-names-cycle.pdf");
        let mut doc = make_shard(1, "ncycle");
        let node_id = doc.new_object_id();
        doc.objects.insert(
            node_id,
            Object::Dictionary(dictionary! {
                "Kids" => vec![Object::Reference(node_id)],
            }),
        );
        let catalog_id = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        doc.get_object_mut(catalog_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set(
                "Names",
                dictionary! { "Dests" => Object::Reference(node_id) },
            );

        let mut assembly = Assembly::new(&out).unwrap();
        let result = assembly.append_shard_doc(doc);
        std::fs::remove_file(&out).ok();
        assert!(matches!(
            result,
            Err(AssemblyError::Malformed(message)) if message.contains("cycle in /Names/Dests")
        ));
    }

    #[test]
    fn outline_survives_write_and_reload() {
        let out = std::env::temp_dir().join("shardpdf-core-test-outline.pdf");
        let mut assembly = Assembly::new(&out).unwrap();
        assembly.append_shard_doc(make_shard(2, "o1")).unwrap();
        assembly.append_shard_doc(make_shard(2, "o2")).unwrap();
        let entries = [
            OutlineEntry {
                title: "First".into(),
                page_index: 0,
                level: 0,
            },
            OutlineEntry {
                title: "동호수".into(),
                page_index: 1,
                level: 1,
            },
            OutlineEntry {
                title: "Second".into(),
                page_index: 2,
                level: 0,
            },
        ];
        assembly.finalize(Some(&entries)).unwrap();
        let merged = Document::load(&out).unwrap();
        std::fs::remove_file(&out).ok();

        let catalog = merged
            .get_object(merged.trailer.get(b"Root").unwrap().as_reference().unwrap())
            .unwrap()
            .as_dict()
            .unwrap();
        let outlines_id = catalog.get(b"Outlines").unwrap().as_reference().unwrap();
        let root = merged.get_object(outlines_id).unwrap().as_dict().unwrap();
        assert_eq!(root.get(b"Count").unwrap().as_i64().unwrap(), 3);

        let first_id = root.get(b"First").unwrap().as_reference().unwrap();
        let first = merged.get_object(first_id).unwrap().as_dict().unwrap();
        assert_eq!(first.get(b"Title").unwrap().as_str().unwrap(), b"First");
        let dest = first.get(b"Dest").unwrap().as_array().unwrap();
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
        assert_eq!(target_type, b"Page");

        let child_id = first.get(b"First").unwrap().as_reference().unwrap();
        let child = merged.get_object(child_id).unwrap().as_dict().unwrap();
        let title = child.get(b"Title").unwrap().as_str().unwrap();
        assert_eq!(&title[..2], &[0xfe, 0xff], "Korean title is UTF-16BE");
    }

    #[test]
    fn indirect_stream_lengths_are_inlined() {
        // pdfkit writes /Length as an indirect reference; the output must
        // still parse with correct stream framing.
        let mut doc = make_shard(1, "len");
        // Rewrite the first stream's Length as an indirect reference.
        let stream_id = doc
            .objects
            .iter()
            .find(|(_, o)| matches!(o, Object::Stream(_)))
            .map(|(&id, _)| id)
            .unwrap();
        let len = match doc.get_object(stream_id).unwrap() {
            Object::Stream(s) => s.content.len() as i64,
            _ => unreachable!(),
        };
        let len_id = doc.add_object(Object::Integer(len));
        if let Object::Stream(s) = doc.get_object_mut(stream_id).unwrap() {
            s.dict.set("Length", Object::Reference(len_id));
        }
        let merged = assemble(vec![doc], "indirect-length");
        let pages: Vec<ObjectId> = merged.get_pages().into_values().collect();
        assert!(page_text(&merged, pages[0]).contains("len-p0"));
    }

    /// A shard that went through incremental updates carries objects with a
    /// non-zero generation. The output xref is a fresh table, so every entry
    /// must be generation 0 and every header/reference must agree with it.
    #[test]
    fn non_zero_generations_are_normalized() {
        let mut doc = make_shard(1, "gen");
        let stream_id = doc
            .objects
            .iter()
            .find(|(_, o)| matches!(o, Object::Stream(_)))
            .map(|(&id, _)| id)
            .unwrap();
        let stream = doc.objects.remove(&stream_id).unwrap();
        let bumped = (stream_id.0, 2);
        doc.objects.insert(bumped, stream);
        doc.traverse_objects(|object| {
            if let Object::Reference(id) = object {
                if *id == stream_id {
                    *id = bumped;
                }
            }
        });

        let out = std::env::temp_dir().join("shardpdf-core-test-generation.pdf");
        assemble_to(vec![doc], &out);
        let bytes = std::fs::read(&out).unwrap();
        std::fs::remove_file(&out).ok();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains(" 2 obj"), "object header kept generation 2");
        assert!(!text.contains(" 2 R"), "reference kept generation 2");

        let merged = Document::load_mem(&bytes).unwrap();
        let pages: Vec<ObjectId> = merged.get_pages().into_values().collect();
        assert!(page_text(&merged, pages[0]).contains("gen-p0"));
    }

    /// A ~250 KB shard whose /ObjStm (holding the catalog, pages, and page)
    /// inflates to `inflated_bytes`. lopdf decodes object streams eagerly on
    /// load, so without a bound this allocates the whole payload before the
    /// assembler sees a page. Hand-built because lopdf's writer will not
    /// emit an object stream with a whitespace tail.
    fn bomb_shard(inflated_bytes: usize) -> Vec<u8> {
        use std::io::Write;
        let objs: [&[u8]; 3] = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        ];
        let mut inner = Vec::new();
        let mut header = String::new();
        for (i, o) in objs.iter().enumerate() {
            header.push_str(&format!("{} {} ", i + 1, inner.len()));
            inner.extend_from_slice(o);
            inner.push(b'\n');
        }
        inner.extend(std::iter::repeat_n(b' ', inflated_bytes));
        let first = header.len();
        let mut payload = header.into_bytes();
        payload.extend_from_slice(&inner);
        let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        enc.write_all(&payload).unwrap();
        let packed = enc.finish().unwrap();

        let mut pdf = b"%PDF-1.5\n".to_vec();
        let objstm_off = pdf.len();
        pdf.extend_from_slice(
            format!(
                "4 0 obj\n<< /Type /ObjStm /N 3 /First {first} /Filter /FlateDecode /Length {} >>\nstream\n",
                packed.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(&packed);
        pdf.extend_from_slice(b"\nendstream\nendobj\n");
        let xref_off = pdf.len();
        let row = |t: u8, f2: u32, f3: u16| {
            let mut r = vec![t];
            r.extend_from_slice(&f2.to_be_bytes());
            r.extend_from_slice(&f3.to_be_bytes());
            r
        };
        let mut rows = row(0, 0, 65535);
        for i in 0..3u16 {
            rows.extend(row(2, 4, i));
        }
        rows.extend(row(1, objstm_off as u32, 0));
        rows.extend(row(1, xref_off as u32, 0));
        pdf.extend_from_slice(
            format!(
                "5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 2] /Root 1 0 R /Length {} >>\nstream\n",
                rows.len()
            )
            .as_bytes(),
        );
        pdf.extend_from_slice(&rows);
        pdf.extend_from_slice(
            format!("\nendstream\nendobj\nstartxref\n{xref_off}\n%%EOF\n").as_bytes(),
        );
        assert!(pdf.len() < 512 * 1024, "bomb must be small on disk");
        pdf
    }

    /// With a limit, lopdf skips the over-budget object stream (it does not
    /// surface the error), so the shard arrives with no pages and the
    /// assembler rejects it as malformed. The important property is that
    /// the payload is never allocated; the unbounded load is the control.
    #[test]
    fn decompression_limit_rejects_a_zip_bomb_before_it_inflates() {
        let bytes = bomb_shard(32 * 1024 * 1024);
        let path = std::env::temp_dir().join("shardpdf-core-test-bomb.pdf");
        std::fs::write(&path, &bytes).unwrap();
        let out = std::env::temp_dir().join("shardpdf-core-test-bomb-out.pdf");

        let mut bounded = Assembly::with_options(
            &out,
            ShardLoadOptions {
                max_decompressed_bytes: Some(1024 * 1024),
            },
        )
        .unwrap();
        let started = std::time::Instant::now();
        let result = bounded.append_shard_file(&path);
        let elapsed = started.elapsed();
        assert!(
            matches!(result, Err(AssemblyError::Malformed(ref m)) if m.contains("no pages")),
            "expected rejection, got {result:?}"
        );
        assert!(
            elapsed < std::time::Duration::from_millis(50),
            "bounded load took {elapsed:?}; the payload was inflated"
        );

        // Control: same shard, no limit, is a legal one-page document.
        let mut unbounded = Assembly::new(&out).unwrap();
        assert_eq!(unbounded.append_shard_file(&path).unwrap(), 1);

        std::fs::remove_file(&path).ok();
        std::fs::remove_file(&out).ok();
    }

    /// Modern producers pack objects into /ObjStm containers and use xref
    /// streams. lopdf unpacks them but keeps the containers in `objects`;
    /// they must not be copied into the output as orphan blobs.
    #[test]
    fn object_stream_containers_are_not_copied() {
        let mut bytes = Vec::new();
        make_shard(2, "objstm").save_modern(&mut bytes).unwrap();
        let source = String::from_utf8_lossy(&bytes);
        assert!(
            source.contains("/ObjStm"),
            "fixture must use object streams"
        );

        let shard = Document::load_mem(&bytes).unwrap();
        let out = std::env::temp_dir().join("shardpdf-core-test-objstm.pdf");
        assemble_to(vec![shard], &out);
        let output = std::fs::read(&out).unwrap();
        std::fs::remove_file(&out).ok();
        let text = String::from_utf8_lossy(&output);
        assert!(
            !text.contains("/ObjStm"),
            "ObjStm container leaked into output"
        );
        assert!(
            !text.contains("/Type /XRef"),
            "xref stream leaked into output"
        );

        let merged = Document::load_mem(&output).unwrap();
        let pages: Vec<ObjectId> = merged.get_pages().into_values().collect();
        assert_eq!(pages.len(), 2);
        assert!(page_text(&merged, pages[1]).contains("objstm-p1"));
    }
}
