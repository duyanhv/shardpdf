//! Writes seed PDFs for the fuzz corpus:
//!   cargo run -p shardpdf-core --example gen_fuzz_seed
//! Seeds land in fuzz/corpus/append_shard/.

use lopdf::{dictionary, Document, Object, Stream};
use std::fs;
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fuzz/corpus/append_shard");
    fs::create_dir_all(&dir).expect("create corpus dir");

    let mut doc = Document::with_version("1.7");
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier",
    });
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    let mut names = Vec::new();
    for i in 0..2 {
        let content = format!("BT /F1 12 Tf 72 720 Td (seed-p{i}) Tj ET");
        let stream_id = doc.add_object(Object::Stream(Stream::new(
            dictionary! {},
            content.into_bytes(),
        )));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "Contents" => Object::Reference(stream_id),
        });
        names.push(Object::string_literal(format!("seed-p{i}")));
        names.push(Object::Array(vec![
            Object::Reference(page_id),
            "XYZ".into(),
            Object::Null,
            Object::Null,
            Object::Null,
        ]));
        kids.push(Object::Reference(page_id));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Count" => 2, "Kids" => kids,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! {
                "Font" => dictionary! { "F1" => Object::Reference(font_id) },
            },
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
        "Names" => dictionary! {
            "Dests" => dictionary! { "Names" => Object::Array(names) },
        },
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let seed_path = dir.join("seed-shard.pdf");
    doc.save(&seed_path).expect("write seed");
    println!("wrote {}", seed_path.display());
}
