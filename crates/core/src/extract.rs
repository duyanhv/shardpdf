//! Page-range extraction: the qpdfExtractPages replacement. Pulls an
//! inclusive, 1-based page range out of a source PDF into a new document,
//! copying only objects reachable from the selected pages.
//!
//! v1 scope (documented, matches the selective-download use case it serves):
//! - ALL annotations (`/Annots`: links, widgets, anything else) are dropped
//!   from extracted pages. (qpdf keeps them, but any link target outside the
//!   range dangles silently — we prefer no link over a dead one. Widgets are
//!   lost too; that is a real gap, not parity.)
//! - Named destinations and outlines are not carried over — same behavior as
//!   a qpdf page slice, whose output has no bookmarks either.
//! - Working set is O(source parse + extracted objects), not O(one shard):
//!   extraction reads an existing document, it does not stream shards.

use crate::assembler::{
    load_document, load_source, Assembly, AssemblyError, PdfSource, Result, ShardLoadOptions,
};
use lopdf::{dictionary, Document, Object, ObjectId};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

pub fn extract_pages(
    input_path: &Path,
    start_page: u32,
    end_page: u32,
    output_path: &Path,
) -> Result<u32> {
    extract_pages_with_options(
        input_path,
        start_page,
        end_page,
        output_path,
        &ShardLoadOptions::default(),
    )
}

/// Inclusive, 1-based range form. Range errors are `Malformed` (the
/// original contract for this entry point); the work is shared with
/// [`extract_selection`].
pub fn extract_pages_with_options(
    input_path: &Path,
    start_page: u32,
    end_page: u32,
    output_path: &Path,
    load_options: &ShardLoadOptions,
) -> Result<u32> {
    if start_page < 1 || start_page > end_page {
        return Err(AssemblyError::Malformed(format!(
            "invalid page range {start_page}-{end_page} (1-based, inclusive)"
        )));
    }

    let source = load_document(input_path, load_options)?;
    let total = source.get_pages().len() as u32;
    if end_page > total {
        return Err(AssemblyError::Malformed(format!(
            "page range {start_page}-{end_page} exceeds document length {total}"
        )));
    }
    let indices: Vec<usize> = ((start_page as usize - 1)..(end_page as usize)).collect();
    extract_selection_from_doc(source, &indices, output_path)
}

/// Extracts `pages` (zero-based indices, emitted in the given order) from
/// `source` into a new PDF at `output_path`. The source is parsed exactly
/// once. Returns the extracted page count.
///
/// Selection errors are [`AssemblyError::InvalidSelection`]: empty
/// selection, duplicate index, or an index `>= page count`.
pub fn extract_selection(
    source: PdfSource<'_>,
    pages: &[usize],
    output_path: &Path,
    load_options: &ShardLoadOptions,
) -> Result<u32> {
    if pages.is_empty() {
        return Err(AssemblyError::InvalidSelection(
            "pages must contain at least one index".into(),
        ));
    }
    let doc = load_source(source, load_options)?;
    extract_selection_from_doc(doc, pages, output_path)
}

/// Shared core: validates `pages` against the parsed document, copies the
/// reachable object graph for the selected pages, and writes the result.
fn extract_selection_from_doc(
    mut source: Document,
    pages: &[usize],
    output_path: &Path,
) -> Result<u32> {
    if pages.is_empty() {
        return Err(AssemblyError::InvalidSelection(
            "pages must contain at least one index".into(),
        ));
    }
    let all_pages: Vec<ObjectId> = source.get_pages().into_values().collect();
    let total = all_pages.len();
    let mut seen = BTreeSet::new();
    let mut selected: Vec<ObjectId> = Vec::with_capacity(pages.len());
    for (position, &index) in pages.iter().enumerate() {
        if index >= total {
            return Err(AssemblyError::InvalidSelection(format!(
                "pages[{position}] = {index} is out of range for a {total}-page document (zero-based)"
            )));
        }
        if !seen.insert(index) {
            return Err(AssemblyError::InvalidSelection(format!(
                "pages[{position}] = {index} is a duplicate"
            )));
        }
        selected.push(all_pages[index]);
    }

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

    fn select_to(
        source: PdfSource<'_>,
        pages: &[usize],
        name: &str,
    ) -> Result<(u32, Document, Vec<u8>)> {
        let out = std::env::temp_dir().join(format!("shardpdf-extract-sel-{name}.pdf"));
        let count = extract_selection(source, pages, &out, &ShardLoadOptions::default())?;
        let bytes = std::fs::read(&out)?;
        let doc = Document::load(&out)?;
        std::fs::remove_file(&out).ok();
        Ok((count, doc, bytes))
    }

    fn page_texts(doc: &Document) -> Vec<String> {
        doc.get_pages()
            .into_values()
            .map(|id| page_text(doc, id))
            .collect()
    }

    #[test]
    fn selection_preserves_requested_order() {
        let source = write_source(5, "sel-order");
        let (count, doc, _) = select_to(PdfSource::Path(&source), &[3, 0, 4], "order").unwrap();
        std::fs::remove_file(&source).ok();
        assert_eq!(count, 3);
        let texts = page_texts(&doc);
        assert_eq!(texts.len(), 3);
        for (text, want) in texts.iter().zip(["src-p3", "src-p0", "src-p4"]) {
            assert!(text.contains(want), "expected {want}, got {text:?}");
        }
    }

    #[test]
    fn selection_rejects_duplicates() {
        let source = write_source(3, "sel-dup");
        let result = select_to(PdfSource::Path(&source), &[1, 1], "dup");
        std::fs::remove_file(&source).ok();
        assert!(
            matches!(result, Err(AssemblyError::InvalidSelection(ref m)) if m.contains("duplicate")),
            "{result:?}"
        );
    }

    #[test]
    fn selection_rejects_empty() {
        let source = write_source(3, "sel-empty");
        let result = select_to(PdfSource::Path(&source), &[], "empty");
        std::fs::remove_file(&source).ok();
        assert!(matches!(result, Err(AssemblyError::InvalidSelection(_))));
    }

    #[test]
    fn selection_single_page() {
        let source = write_source(4, "sel-single");
        let (count, doc, _) = select_to(PdfSource::Path(&source), &[1], "single").unwrap();
        std::fs::remove_file(&source).ok();
        assert_eq!(count, 1);
        let texts = page_texts(&doc);
        assert_eq!(texts.len(), 1);
        assert!(texts[0].contains("src-p1"));
    }

    #[test]
    fn selection_last_page() {
        let source = write_source(4, "sel-last");
        let (count, doc, _) = select_to(PdfSource::Path(&source), &[3], "last").unwrap();
        std::fs::remove_file(&source).ok();
        assert_eq!(count, 1);
        assert!(page_texts(&doc)[0].contains("src-p3"));
    }

    #[test]
    fn selection_rejects_out_of_range() {
        let source = write_source(4, "sel-oor");
        let result = select_to(PdfSource::Path(&source), &[0, 4], "oor");
        std::fs::remove_file(&source).ok();
        assert!(
            matches!(result, Err(AssemblyError::InvalidSelection(ref m)) if m.contains("out of range")),
            "{result:?}"
        );
    }

    #[test]
    fn selection_bytes_and_path_are_equivalent() {
        let source = write_source(5, "sel-bytes");
        let bytes = std::fs::read(&source).unwrap();
        let (count_a, _, out_a) = select_to(PdfSource::Path(&source), &[4, 2], "bytes-a").unwrap();
        let (count_b, _, out_b) = select_to(PdfSource::Bytes(&bytes), &[4, 2], "bytes-b").unwrap();
        std::fs::remove_file(&source).ok();
        assert_eq!(count_a, 2);
        assert_eq!(count_a, count_b);
        assert_eq!(
            out_a, out_b,
            "path and bytes extraction must produce identical output"
        );
    }

    #[test]
    fn selection_matches_range_extraction() {
        let source = write_source(5, "sel-range");
        let (_, _, ranged) = {
            let out = std::env::temp_dir().join("shardpdf-extract-sel-range-ref.pdf");
            let count = extract_pages(&source, 2, 4, &out).unwrap();
            let bytes = std::fs::read(&out).unwrap();
            std::fs::remove_file(&out).ok();
            (count, (), bytes)
        };
        let (_, _, selected) = select_to(PdfSource::Path(&source), &[1, 2, 3], "range").unwrap();
        std::fs::remove_file(&source).ok();
        assert_eq!(ranged, selected);
    }

    #[test]
    fn page_count_reads_without_writing() {
        let source = write_source(7, "count");
        let bytes = std::fs::read(&source).unwrap();
        let opts = ShardLoadOptions::default();
        assert_eq!(
            crate::assembler::page_count(PdfSource::Path(&source), &opts).unwrap(),
            7
        );
        assert_eq!(
            crate::assembler::page_count(PdfSource::Bytes(&bytes), &opts).unwrap(),
            7
        );
        std::fs::remove_file(&source).ok();
        assert!(matches!(
            crate::assembler::page_count(PdfSource::Bytes(b"not a pdf"), &opts),
            Err(AssemblyError::Pdf(_))
        ));
    }
}
