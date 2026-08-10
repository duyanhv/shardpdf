//! Read-only inspection: page counting and structural validation, so
//! consumers stop needing a qpdf binary to sanity-check shardpdf output.

use crate::assembler::{extract_named_dests, AssemblyError, Result};
use lopdf::{Document, Object, ObjectId};
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct ValidationReport {
    pub page_count: u32,
    pub named_destinations: u32,
}

/// Parses the document and returns its page count (parse failure = error).
pub fn page_count(input_path: &Path) -> Result<u32> {
    let doc = Document::load(input_path)?;
    Ok(doc.get_pages().len() as u32)
}

/// Structural validation: the document parses, every page resolves to a page
/// dictionary, and every named destination targets a live page. This is the
/// check qpdf --check cannot do (it accepts silently-dangling destinations —
/// the exact corruption merge tools ship).
pub fn validate(input_path: &Path) -> Result<ValidationReport> {
    let doc = Document::load(input_path)?;
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let page_set: BTreeSet<ObjectId> = pages.iter().copied().collect();

    for &page_id in &pages {
        doc.get_object(page_id)?.as_dict().map_err(|_| {
            AssemblyError::Malformed(format!(
                "page object {} {} is not a dictionary",
                page_id.0, page_id.1
            ))
        })?;
    }

    let dests = extract_named_dests(&doc)?;
    for (name, dest) in &dests {
        let target = resolve_dest_page(&doc, dest);
        match target {
            Some(id) if page_set.contains(&id) => {}
            _ => {
                return Err(AssemblyError::DanglingDestination(format!(
                    "{:?} does not target a live page",
                    String::from_utf8_lossy(name)
                )));
            }
        }
    }

    Ok(ValidationReport {
        page_count: pages.len() as u32,
        named_destinations: dests.len() as u32,
    })
}

/// A destination is an array whose first element references the target page,
/// possibly behind an indirect reference to the array itself.
fn resolve_dest_page(doc: &Document, dest: &Object) -> Option<ObjectId> {
    let mut current = dest;
    for _ in 0..8 {
        match current {
            Object::Reference(id) => current = doc.get_object(*id).ok()?,
            Object::Array(items) => return items.first()?.as_reference().ok(),
            _ => return None,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembler::test_support::{assemble_to, make_shard};
    use lopdf::dictionary;

    fn write_doc(name: &str) -> std::path::PathBuf {
        let out = std::env::temp_dir().join(format!("shardpdf-inspect-{name}.pdf"));
        assemble_to(vec![make_shard(3, "v")], &out);
        out
    }

    #[test]
    fn counts_pages_and_destinations() {
        let doc = write_doc("count");
        assert_eq!(page_count(&doc).unwrap(), 3);
        let report = validate(&doc).unwrap();
        std::fs::remove_file(&doc).ok();
        assert_eq!(report.page_count, 3);
        assert_eq!(report.named_destinations, 3);
    }

    #[test]
    fn extraction_output_validates_even_though_dests_are_dropped() {
        let doc = write_doc("extract-valid");
        let slice = std::env::temp_dir().join("shardpdf-inspect-slice.pdf");
        crate::extract::extract_pages(&doc, 2, 3, &slice).unwrap();
        let report = validate(&slice).unwrap();
        std::fs::remove_file(&doc).ok();
        std::fs::remove_file(&slice).ok();
        assert_eq!(report.page_count, 2);
        assert_eq!(report.named_destinations, 0);
    }

    #[test]
    fn dangling_destination_is_detected() {
        // Build a shard whose name tree targets a page, then point one dest
        // at a non-page object before assembling by hand.
        let mut shard = make_shard(2, "bad");
        let dests = extract_named_dests(&shard).unwrap();
        assert!(!dests.is_empty());
        // Rewrite the first destination array's target to a bogus reference.
        let root = shard.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let catalog = shard.get_object(root).unwrap().as_dict().unwrap();
        let names = catalog.get(b"Names").unwrap().as_dict().unwrap();
        let dests_node = names.get(b"Dests").unwrap().as_dict().unwrap();
        let names_array = dests_node
            .get(b"Names")
            .unwrap()
            .as_array()
            .unwrap()
            .clone();
        let mut rewritten = names_array;
        if let Some(Object::Array(dest)) = rewritten.get_mut(1) {
            dest[0] = Object::Reference((9999, 0));
        }
        let root_id = root;
        let catalog_dict = shard
            .get_object_mut(root_id)
            .unwrap()
            .as_dict_mut()
            .unwrap();
        catalog_dict.set(
            "Names",
            dictionary! {
                "Dests" => dictionary! { "Names" => rewritten },
            },
        );

        let out = std::env::temp_dir().join("shardpdf-inspect-dangling.pdf");
        // Bypass the assembler (it would fail on the missing object): save the
        // shard directly and validate that raw file.
        shard.save(&out).unwrap();
        let result = validate(&out);
        std::fs::remove_file(&out).ok();
        assert!(matches!(result, Err(AssemblyError::DanglingDestination(_))));
    }
}
