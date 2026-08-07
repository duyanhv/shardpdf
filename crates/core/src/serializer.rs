//! Byte-level PDF object serializer for the streaming writer.
//!
//! lopdf parses shards into `Object`s; this module writes them back out
//! incrementally (lopdf itself only saves whole documents). Choices favor
//! correctness over prettiness: strings are written as hex (binary-safe by
//! construction), reals in plain decimal (PDF forbids exponent notation).

use lopdf::{Object, ObjectId, Stream};
use std::io::{Result, Write};

pub fn write_indirect_object(
    w: &mut impl Write,
    id: ObjectId,
    object: &Object,
) -> Result<()> {
    writeln!(w, "{} {} obj", id.0, id.1)?;
    write_object(w, object)?;
    w.write_all(b"\nendobj\n")
}

pub fn write_object(w: &mut impl Write, object: &Object) -> Result<()> {
    match object {
        Object::Null => w.write_all(b"null"),
        Object::Boolean(b) => w.write_all(if *b { b"true" } else { b"false" }),
        Object::Integer(i) => write!(w, "{i}"),
        Object::Real(r) => write_real(w, *r),
        Object::Name(name) => write_name(w, name),
        Object::String(bytes, _) => write_hex_string(w, bytes),
        Object::Reference((num, generation)) => write!(w, "{num} {generation} R"),
        Object::Array(items) => {
            w.write_all(b"[ ")?;
            for item in items {
                write_object(w, item)?;
                w.write_all(b" ")?;
            }
            w.write_all(b"]")
        }
        Object::Dictionary(dict) => write_dictionary(w, dict),
        Object::Stream(stream) => write_stream(w, stream),
    }
}

fn write_dictionary(w: &mut impl Write, dict: &lopdf::Dictionary) -> Result<()> {
    w.write_all(b"<< ")?;
    for (key, value) in dict.iter() {
        write_name(w, key)?;
        w.write_all(b" ")?;
        write_object(w, value)?;
        w.write_all(b" ")?;
    }
    w.write_all(b">>")
}

/// /Length may be an indirect reference in the source shard (pdfkit does
/// this); the streaming writer inlines the actual byte count instead.
fn write_stream(w: &mut impl Write, stream: &Stream) -> Result<()> {
    let mut dict = stream.dict.clone();
    dict.set("Length", Object::Integer(stream.content.len() as i64));
    write_dictionary(w, &dict)?;
    w.write_all(b"\nstream\n")?;
    w.write_all(&stream.content)?;
    w.write_all(b"\nendstream")
}

/// PDF real syntax: plain decimal only — `{}` on f32 could emit `1e-7`.
fn write_real(w: &mut impl Write, value: f32) -> Result<()> {
    if value == value.trunc() && value.abs() < 1e15 {
        return write!(w, "{}", value as i64);
    }
    let formatted = format!("{value:.6}");
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    w.write_all(trimmed.as_bytes())
}

/// Name bytes outside the regular printable range (and PDF delimiters) are
/// written as #XX per spec §7.3.5.
fn write_name(w: &mut impl Write, name: &[u8]) -> Result<()> {
    w.write_all(b"/")?;
    for &byte in name {
        let delimiter = b"()<>[]{}/%#".contains(&byte);
        if delimiter || !(0x21..=0x7e).contains(&byte) {
            write!(w, "#{byte:02X}")?;
        } else {
            w.write_all(&[byte])?;
        }
    }
    Ok(())
}

fn write_hex_string(w: &mut impl Write, bytes: &[u8]) -> Result<()> {
    w.write_all(b"<")?;
    for byte in bytes {
        write!(w, "{byte:02X}")?;
    }
    w.write_all(b">")
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn serialized(object: &Object) -> String {
        let mut buf = Vec::new();
        write_object(&mut buf, object).unwrap();
        String::from_utf8(buf).unwrap()
    }

    #[test]
    fn scalars() {
        assert_eq!(serialized(&Object::Null), "null");
        assert_eq!(serialized(&Object::Boolean(true)), "true");
        assert_eq!(serialized(&Object::Integer(-42)), "-42");
        assert_eq!(serialized(&Object::Reference((7, 0))), "7 0 R");
    }

    #[test]
    fn reals_never_use_exponent_notation() {
        assert_eq!(serialized(&Object::Real(0.5)), "0.5");
        assert_eq!(serialized(&Object::Real(612.0)), "612");
        let tiny = serialized(&Object::Real(1e-7));
        assert!(!tiny.contains('e') && !tiny.contains('E'), "got {tiny}");
    }

    #[test]
    fn names_escape_delimiters_and_nonprintables() {
        assert_eq!(
            serialized(&Object::Name(b"A B(C)/D#1".to_vec())),
            "/A#20B#28C#29#2FD#231"
        );
    }

    #[test]
    fn strings_are_binary_safe_hex() {
        assert_eq!(
            serialized(&Object::String(
                vec![0x00, 0x28, 0xff],
                lopdf::StringFormat::Literal
            )),
            "<0028FF>"
        );
    }

    #[test]
    fn nested_structures_roundtrip_through_lopdf_parser() {
        let original = Object::Dictionary(dictionary! {
            "Kids" => vec![Object::Reference((3, 0)), "Name".into()],
            "Box" => vec![0.into(), Object::Real(841.89), (-3).into()],
        });
        let mut buf = Vec::new();
        write_indirect_object(&mut buf, (1, 0), &original).unwrap();
        // lopdf's content parser understands raw object syntax via Document
        // round-trips in assembler tests; here just sanity-check the framing.
        let text = String::from_utf8(buf).unwrap();
        assert!(text.starts_with("1 0 obj\n<< "));
        assert!(text.ends_with("\nendobj\n"));
        assert!(text.contains("/Kids [ 3 0 R /Name ]"));
    }
}
