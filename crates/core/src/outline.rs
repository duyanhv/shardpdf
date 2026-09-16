//! /Outlines (bookmark) tree construction for finalize().
//!
//! Input is a flat preorder list with nesting levels — the shape callers
//! naturally have (section index, TOC data) and the shape that serializes
//! cleanly over napi. The tree (Parent/Prev/Next/First/Last/Count) is built
//! here. All items are written open: /Count = total visible descendants.

use crate::assembler::{AssemblyError, Result};
use lopdf::{dictionary, Object, ObjectId, StringFormat};

#[derive(Debug, Clone)]
pub struct OutlineEntry {
    pub title: String,
    /// 0-based absolute page index in the assembled document.
    pub page_index: u32,
    /// Nesting depth; a child is exactly one level deeper than its parent.
    pub level: u32,
}

/// PDF text string bytes: ASCII stays as-is (PDFDocEncoding-compatible);
/// anything else becomes UTF-16BE with BOM (spec §7.9.2.2) — required for
/// e.g. Korean titles.
fn text_string_bytes(title: &str) -> Vec<u8> {
    if title.is_ascii() {
        return title.as_bytes().to_vec();
    }
    let mut bytes = vec![0xfe, 0xff];
    for unit in title.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    bytes
}

/// Number of entries in `entries[start..]` that are descendants of
/// `entries[start - 1]` (i.e. the run of entries deeper than `level`).
fn descendant_count(entries: &[OutlineEntry], start: usize, level: u32) -> usize {
    entries[start..]
        .iter()
        .take_while(|entry| entry.level > level)
        .count()
}

/// Builds the outline objects. Returns `(root_id, objects)` where `objects`
/// are (id, object) pairs ready to be written; ids are allocated from
/// `alloc`. `page_ids[entry.page_index]` becomes each item's /Dest target.
pub fn build_outline_objects(
    entries: &[OutlineEntry],
    page_ids: &[ObjectId],
    alloc: &mut impl FnMut() -> ObjectId,
) -> Result<(ObjectId, Vec<(ObjectId, Object)>)> {
    if entries.is_empty() {
        return Err(AssemblyError::InvalidOutline("empty outline".into()));
    }
    // Validate structure fully before building: later passes assume that a
    // deeper entry always has a direct (level + 1) parent above it.
    let mut depth = 0usize;
    for (i, entry) in entries.iter().enumerate() {
        if entry.level as usize > depth {
            return Err(AssemblyError::InvalidOutline(format!(
                "outline entry {i} (\"{}\") jumps from level {depth} to {}",
                entry.title, entry.level
            )));
        }
        depth = entry.level as usize + 1;
    }

    let ids: Vec<ObjectId> = entries.iter().map(|_| alloc()).collect();
    let root_id = alloc();

    // Validate structure and resolve relationships in one pass.
    let mut parent_stack: Vec<usize> = Vec::new(); // indices of open ancestors
    let mut prev_at_level: Vec<Option<usize>> = Vec::new(); // last sibling per level
    let mut dicts: Vec<lopdf::Dictionary> = Vec::with_capacity(entries.len());

    for (i, entry) in entries.iter().enumerate() {
        let level = entry.level as usize;
        if level > parent_stack.len() {
            return Err(AssemblyError::InvalidOutline(format!(
                "outline entry {i} (\"{}\") jumps from level {} to {}",
                entry.title,
                parent_stack.len(),
                entry.level
            )));
        }
        parent_stack.truncate(level);
        prev_at_level.truncate(level + 1);
        if prev_at_level.len() < level + 1 {
            prev_at_level.resize(level + 1, None);
        }

        let page = page_ids.get(entry.page_index as usize).ok_or_else(|| {
            AssemblyError::InvalidOutline(format!(
                "outline entry \"{}\" targets page index {} but document has {} pages",
                entry.title,
                entry.page_index,
                page_ids.len()
            ))
        })?;

        let parent_id = match parent_stack.last() {
            Some(&parent_index) => ids[parent_index],
            None => root_id,
        };
        let mut dict = dictionary! {
            "Title" => Object::String(text_string_bytes(&entry.title), StringFormat::Literal),
            "Parent" => Object::Reference(parent_id),
            "Dest" => vec![
                Object::Reference(*page),
                "XYZ".into(),
                Object::Null,
                Object::Null,
                Object::Null,
            ],
        };

        if let Some(prev_index) = prev_at_level[level] {
            dict.set("Prev", Object::Reference(ids[prev_index]));
            dicts[prev_index].set("Next", Object::Reference(ids[i]));
        }

        let descendants = descendant_count(entries, i + 1, entry.level);
        if descendants > 0 {
            dict.set("First", Object::Reference(ids[i + 1]));
            // Last direct child: the last descendant at exactly level + 1.
            let last_child = (i + 1..=i + descendants)
                .rev()
                .find(|&j| entries[j].level == entry.level + 1)
                .expect("descendants exist, so a direct child exists");
            dict.set("Last", Object::Reference(ids[last_child]));
            dict.set("Count", Object::Integer(descendants as i64));
        }

        prev_at_level[level] = Some(i);
        parent_stack.push(i);
        dicts.push(dict);
    }

    let top_level: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.level == 0)
        .map(|(i, _)| i)
        .collect();
    let first_top = *top_level.first().expect("non-empty, level-0 first entry");
    let last_top = *top_level.last().expect("non-empty");
    let root = dictionary! {
        "Type" => "Outlines",
        "First" => Object::Reference(ids[first_top]),
        "Last" => Object::Reference(ids[last_top]),
        "Count" => Object::Integer(entries.len() as i64),
    };

    let mut objects: Vec<(ObjectId, Object)> = ids
        .into_iter()
        .zip(dicts.into_iter().map(Object::Dictionary))
        .collect();
    objects.push((root_id, Object::Dictionary(root)));
    Ok((root_id, objects))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(title: &str, page: u32, level: u32) -> OutlineEntry {
        OutlineEntry {
            title: title.into(),
            page_index: page,
            level,
        }
    }

    fn build(
        entries: &[OutlineEntry],
        pages: usize,
    ) -> Result<(ObjectId, Vec<(ObjectId, Object)>)> {
        let page_ids: Vec<ObjectId> = (0..pages as u32).map(|i| (100 + i, 0)).collect();
        let mut next = 500u32;
        let mut alloc = || {
            next += 1;
            (next, 0)
        };
        build_outline_objects(entries, &page_ids, &mut alloc)
    }

    fn dict_of(objects: &[(ObjectId, Object)], id: ObjectId) -> &lopdf::Dictionary {
        objects
            .iter()
            .find(|(oid, _)| *oid == id)
            .and_then(|(_, o)| o.as_dict().ok())
            .expect("object exists and is a dictionary")
    }

    #[test]
    fn builds_a_nested_tree_with_correct_linkage() {
        let entries = [
            entry("A", 0, 0),
            entry("A.1", 1, 1),
            entry("A.2", 2, 1),
            entry("B", 3, 0),
        ];
        let (root_id, objects) = build(&entries, 4).unwrap();
        assert_eq!(objects.len(), 5);

        let root = dict_of(&objects, root_id);
        assert_eq!(root.get(b"Count").unwrap().as_i64().unwrap(), 4);
        let a_id = root.get(b"First").unwrap().as_reference().unwrap();
        let b_id = root.get(b"Last").unwrap().as_reference().unwrap();

        let a = dict_of(&objects, a_id);
        assert_eq!(a.get(b"Count").unwrap().as_i64().unwrap(), 2);
        assert_eq!(a.get(b"Next").unwrap().as_reference().unwrap(), b_id);
        let a1_id = a.get(b"First").unwrap().as_reference().unwrap();
        let a2_id = a.get(b"Last").unwrap().as_reference().unwrap();
        let a2 = dict_of(&objects, a2_id);
        assert_eq!(a2.get(b"Prev").unwrap().as_reference().unwrap(), a1_id);
        assert_eq!(a2.get(b"Parent").unwrap().as_reference().unwrap(), a_id);

        let b = dict_of(&objects, b_id);
        assert!(b.get(b"First").is_err(), "leaf has no children");
        assert_eq!(b.get(b"Prev").unwrap().as_reference().unwrap(), a_id);
    }

    #[test]
    fn non_ascii_titles_are_utf16be_with_bom() {
        let entries = [entry("동호수 분석", 0, 0)];
        let (root_id, objects) = build(&entries, 1).unwrap();
        let root = dict_of(&objects, root_id);
        let item_id = root.get(b"First").unwrap().as_reference().unwrap();
        let title = dict_of(&objects, item_id)
            .get(b"Title")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(&title[..2], &[0xfe, 0xff], "UTF-16BE BOM required");
        assert_eq!(title.len() % 2, 0);
    }

    #[test]
    fn ascii_titles_stay_plain() {
        let entries = [entry("Cover", 0, 0)];
        let (root_id, objects) = build(&entries, 1).unwrap();
        let root = dict_of(&objects, root_id);
        let item_id = root.get(b"First").unwrap().as_reference().unwrap();
        let title = dict_of(&objects, item_id)
            .get(b"Title")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(title, b"Cover");
    }

    #[test]
    fn rejects_level_jumps_and_bad_pages() {
        assert!(matches!(
            build(&[entry("A", 0, 0), entry("deep", 1, 2)], 4),
            Err(AssemblyError::InvalidOutline(_))
        ));
        assert!(matches!(
            build(&[entry("A", 99, 0)], 4),
            Err(AssemblyError::InvalidOutline(_))
        ));
        assert!(matches!(
            build(&[], 4),
            Err(AssemblyError::InvalidOutline(_))
        ));
    }
}
