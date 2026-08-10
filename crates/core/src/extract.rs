//! Page-range extraction: the qpdf page-slice replacement. An `Extractor`
//! parses the source once and serves any number of inclusive, 1-based range
//! extractions from it — the multi-slice selective-download pattern — copying
//! into each output only objects the selected pages reach.
//!
//! v1 scope (documented, matches the selective-download use case it serves):
//! - Link annotations are dropped from extracted pages. (qpdf keeps them, but
//!   any target outside the range dangles silently — we prefer no link over a
//!   dead one.)
//! - Named destinations and outlines are not carried over — same behavior as
//!   a qpdf page slice, whose output has no bookmarks either.
//! - Working set is O(source parse + one slice), not O(one shard): extraction
//!   reads an existing document, it does not stream shards.

use crate::assembler::{push_down_inherited, Assembly, AssemblyError, Result};
use lopdf::{dictionary, Dictionary, Document, Object, ObjectId};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

pub struct Extractor {
    source: Document,
    pages: Vec<ObjectId>,
}

impl Extractor {
    pub fn open(input_path: &Path) -> Result<Self> {
        let mut source = Document::load(input_path)?;
        let pages: Vec<ObjectId> = source.get_pages().into_values().collect();
        // Selected pages must be self-contained before their parent chain is
        // cut away; pushing down once up front covers every later range.
        push_down_inherited(&mut source, &pages)?;
        Ok(Extractor { source, pages })
    }

    pub fn page_count(&self) -> u32 {
        self.pages.len() as u32
    }

    /// Extracts an inclusive, 1-based page range into `output_path`. The
    /// source stays intact, so ranges may overlap and repeat freely.
    pub fn extract_range(&self, start_page: u32, end_page: u32, output_path: &Path) -> Result<u32> {
        let total = self.pages.len() as u32;
        if start_page < 1 || start_page > end_page || end_page > total {
            return Err(AssemblyError::InvalidRange(format!(
                "{start_page}-{end_page} (1-based inclusive, document has {total} pages)"
            )));
        }
        let selected: Vec<ObjectId> =
            self.pages[(start_page as usize - 1)..(end_page as usize)].to_vec();
        let selected_set: BTreeSet<ObjectId> = selected.iter().copied().collect();

        let reachable = reachable_from(&self.source, &selected, &selected_set)?;
        let mut objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
        for id in reachable {
            let object = self.source.objects.get(&id).ok_or_else(|| {
                AssemblyError::Malformed(format!(
                    "object {} {} referenced but missing from source",
                    id.0, id.1
                ))
            })?;
            objects.insert(id, object.clone());
        }

        let mut pruned = Document::with_version("1.7");
        pruned.objects = objects;
        pruned.max_id = pruned.objects.keys().map(|id| id.0).max().unwrap_or(0);
        let pages_root = pruned.add_object(dictionary! {
            "Type" => "Pages",
            "Count" => selected.len() as i64,
            "Kids" => selected
                .iter()
                .map(|&id| Object::Reference(id))
                .collect::<Vec<Object>>(),
        });
        for &page_id in &selected {
            let page = pruned.get_object_mut(page_id)?.as_dict_mut()?;
            // Parent would drag in the old page tree; the assembler assigns
            // the new parent. Annots are out of v1 scope.
            page.remove(b"Parent");
            page.remove(b"Annots");
            page.set("Parent", Object::Reference(pages_root));
        }
        let catalog = pruned.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_root),
        });
        pruned.trailer.set("Root", Object::Reference(catalog));

        let mut assembly = Assembly::new(output_path)?;
        let count = assembly.append_shard_doc(pruned)?;
        assembly.finalize(None)?;
        Ok(count)
    }
}

/// Single-range convenience over a one-shot [`Extractor`].
pub fn extract_pages(
    input_path: &Path,
    start_page: u32,
    end_page: u32,
    output_path: &Path,
) -> Result<u32> {
    Extractor::open(input_path)?.extract_range(start_page, end_page, output_path)
}

/// BFS over indirect references starting at the selected pages. Page dicts
/// traverse with /Parent and /Annots skipped — Parent would pull in the whole
/// page tree (and every sibling page), Annots are out of v1 scope. Missing
/// targets are an error: an extract must never contain dangling references.
fn reachable_from(
    doc: &Document,
    roots: &[ObjectId],
    page_dicts: &BTreeSet<ObjectId>,
) -> Result<BTreeSet<ObjectId>> {
    let mut seen: BTreeSet<ObjectId> = roots.iter().copied().collect();
    let mut queue: VecDeque<ObjectId> = roots.iter().copied().collect();
    while let Some(id) = queue.pop_front() {
        let object = doc.get_object(id).map_err(|_| {
            AssemblyError::Malformed(format!(
                "object {} {} referenced but missing from source",
                id.0, id.1
            ))
        })?;
        let mut refs = Vec::new();
        if page_dicts.contains(&id) {
            if let Ok(dict) = object.as_dict() {
                collect_page_refs(dict, &mut refs);
            }
        } else {
            collect_refs(object, &mut refs);
        }
        for target in refs {
            if seen.insert(target) {
                queue.push_back(target);
            }
        }
    }
    Ok(seen)
}

fn collect_page_refs(dict: &Dictionary, out: &mut Vec<ObjectId>) {
    for (key, value) in dict.iter() {
        if key == b"Parent" || key == b"Annots" {
            continue;
        }
        collect_refs(value, out);
    }
}

fn collect_refs(object: &Object, out: &mut Vec<ObjectId>) {
    match object {
        Object::Reference(id) => out.push(*id),
        Object::Array(items) => {
            for item in items {
                collect_refs(item, out);
            }
        }
        Object::Dictionary(dict) => {
            for (_, value) in dict.iter() {
                collect_refs(value, out);
            }
        }
        Object::Stream(stream) => {
            for (_, value) in stream.dict.iter() {
                collect_refs(value, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembler::test_support::{assemble_to, make_shard, page_text};

    fn extract_to(source: &Path, start: u32, end: u32, name: &str) -> Result<(u32, Document)> {
        let out = std::env::temp_dir().join(format!("shardpdf-extract-{name}.pdf"));
        let count = extract_pages(source, start, end, &out)?;
        let doc = Document::load(&out)?;
        std::fs::remove_file(&out).ok();
        Ok((count, doc))
    }

    fn write_source(pages: usize, name: &str) -> std::path::PathBuf {
        let out = std::env::temp_dir().join(format!("shardpdf-extract-src-{name}.pdf"));
        assemble_to(vec![make_shard(pages, "src")], &out);
        out
    }

    #[test]
    fn extracts_a_middle_range_with_correct_content() {
        let source = write_source(5, "middle");
        let (count, doc) = extract_to(&source, 2, 4, "middle").unwrap();
        std::fs::remove_file(&source).ok();

        assert_eq!(count, 3);
        let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
        assert_eq!(pages.len(), 3);
        for (page_id, want) in pages.iter().zip(["src-p1", "src-p2", "src-p3"]) {
            assert!(
                page_text(&doc, *page_id).contains(want),
                "expected page containing {want}"
            );
        }
    }

    #[test]
    fn one_parse_serves_many_even_overlapping_ranges() {
        let source = write_source(6, "multi");
        let extractor = Extractor::open(&source).unwrap();
        assert_eq!(extractor.page_count(), 6);

        for (start, end, name) in [(1u32, 2u32, "a"), (2, 5, "b"), (1, 6, "c")] {
            let out = std::env::temp_dir().join(format!("shardpdf-extract-multi-{name}.pdf"));
            let count = extractor.extract_range(start, end, &out).unwrap();
            assert_eq!(count, end - start + 1);
            let doc = Document::load(&out).unwrap();
            assert_eq!(doc.get_pages().len(), (end - start + 1) as usize);
            let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
            assert!(
                page_text(&doc, pages[0]).contains(&format!("src-p{}", start - 1)),
                "first page of {name} is source page {start}"
            );
            std::fs::remove_file(&out).ok();
        }
        std::fs::remove_file(&source).ok();
    }

    #[test]
    fn extracted_pages_keep_inherited_attributes() {
        let source = write_source(3, "inherit");
        let (_, doc) = extract_to(&source, 2, 2, "inherit").unwrap();
        std::fs::remove_file(&source).ok();

        for page_id in doc.get_pages().into_values() {
            let page = doc.get_object(page_id).unwrap().as_dict().unwrap();
            assert!(page.has(b"MediaBox"));
            assert!(page.has(b"Resources"));
        }
    }

    #[test]
    fn output_does_not_carry_unselected_page_content() {
        let source = write_source(5, "prune");
        let out = std::env::temp_dir().join("shardpdf-extract-prune.pdf");
        extract_pages(&source, 1, 1, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        std::fs::remove_file(&out).ok();
        std::fs::remove_file(&source).ok();

        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("src-p0"));
        assert!(
            !text.contains("src-p3"),
            "unselected page content leaked into the extract"
        );
    }

    #[test]
    fn rejects_invalid_ranges_with_the_range_code() {
        let source = write_source(3, "ranges");
        for (start, end) in [(0, 1), (2, 1), (1, 4), (5, 9)] {
            let result = extract_to(&source, start, end, "ranges");
            assert!(
                matches!(&result, Err(AssemblyError::InvalidRange(_))),
                "range {start}-{end} must be InvalidRange"
            );
        }
        std::fs::remove_file(&source).ok();
    }

    #[test]
    fn full_range_roundtrips_every_page() {
        let source = write_source(4, "full");
        let (count, doc) = extract_to(&source, 1, 4, "full").unwrap();
        std::fs::remove_file(&source).ok();
        assert_eq!(count, 4);
        assert_eq!(doc.get_pages().len(), 4);
    }
}
