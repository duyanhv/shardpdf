//! Page-range extraction: the qpdfExtractPages replacement. Pulls an
//! inclusive, 1-based page range out of a source PDF into a new document,
//! copying only objects reachable from the selected pages.
//!
//! v1 scope (documented, matches the selective-download use case it serves):
//! - Link annotations are dropped from extracted pages. (qpdf keeps them, but
//!   any target outside the range dangles silently — we prefer no link over a
//!   dead one.)
//! - Named destinations and outlines are not carried over — same behavior as
//!   a qpdf page slice, whose output has no bookmarks either.
//! - Working set is O(source parse + extracted objects), not O(one shard):
//!   extraction reads an existing document, it does not stream shards.

use crate::assembler::{Assembly, AssemblyError, Result};
use lopdf::{dictionary, Document, Object, ObjectId};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

pub fn extract_pages(
    input_path: &Path,
    start_page: u32,
    end_page: u32,
    output_path: &Path,
) -> Result<u32> {
    if start_page < 1 || start_page > end_page {
        return Err(AssemblyError::Malformed(format!(
            "invalid page range {start_page}-{end_page} (1-based, inclusive)"
        )));
    }

    let mut source = Document::load(input_path)?;
    let all_pages: Vec<ObjectId> = source.get_pages().into_values().collect();
    let total = all_pages.len() as u32;
    if end_page > total {
        return Err(AssemblyError::Malformed(format!(
            "page range {start_page}-{end_page} exceeds document length {total}"
        )));
    }
    let selected: Vec<ObjectId> =
        all_pages[(start_page as usize - 1)..(end_page as usize)].to_vec();

    // Selected pages must be self-contained before their parent chain and
    // sibling pages are cut away.
    crate::assembler::push_down_inherited(&mut source, &selected)?;
    for &page_id in &selected {
        let page = source.get_object_mut(page_id)?.as_dict_mut()?;
        // Parent would drag in the old page tree (and with it every page);
        // the assembler assigns the new parent. Annots are out of v1 scope.
        page.remove(b"Parent");
        page.remove(b"Annots");
    }

    // Everything the selected pages reach — content streams, resources,
    // fonts, images — and nothing else.
    let reachable = reachable_from(&source, &selected)?;
    let mut objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    for id in reachable {
        if let Some(object) = source.objects.remove(&id) {
            objects.insert(id, object);
        }
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

/// BFS over indirect references starting at `roots`. Missing targets are an
/// error: an extracted document must never contain dangling references.
fn reachable_from(doc: &Document, roots: &[ObjectId]) -> Result<BTreeSet<ObjectId>> {
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
        collect_refs(object, &mut refs);
        for target in refs {
            if seen.insert(target) {
                queue.push_back(target);
            }
        }
    }
    Ok(seen)
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
    fn rejects_invalid_ranges() {
        let source = write_source(3, "ranges");
        for (start, end) in [(0, 1), (2, 1), (1, 4), (5, 9)] {
            assert!(
                matches!(
                    extract_to(&source, start, end, "ranges"),
                    Err(AssemblyError::Malformed(_))
                ),
                "range {start}-{end} must be rejected"
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
