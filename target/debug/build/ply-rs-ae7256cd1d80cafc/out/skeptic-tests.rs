extern crate skeptic;
#[test] fn readme_sect_getting_started_line_27() {
    let s = &format!(r####"
{}"####, r####"extern crate ply_rs;

fn main() {}
"####);
    skeptic::rt::run_test(r#"/Users/eeisaman/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/ply-rs-0.1.3"#, r#"/Users/eeisaman/Documents/SIGMA PRODUCTIONS/g2m/target/debug/build/ply-rs-ae7256cd1d80cafc/out"#, r#"aarch64-apple-darwin"#, s);
}

#[test] fn readme_sect_getting_started_line_37() {
    let s = &format!(r####"
{}"####, r####"extern crate ply_rs;
use ply_rs as ply;

/// Demonstrates simplest use case for reading from a file.
fn main() {
    // set up a reader, in this case a file.
    let path = "example_plys/greg_turk_example1_ok_ascii.ply";
    let mut f = std::fs::File::open(path).unwrap();

    // create a parser
    let p = ply::parser::Parser::<ply::ply::DefaultElement>::new();

    // use the parser: read the entire file
    let ply = p.read_ply(&mut f);

    // make sure it did work
    assert!(ply.is_ok());
    let ply = ply.unwrap();

    // proof that data has been read
    println!("Ply header: {:#?}", ply.header);
    println!("Ply data: {:?}", ply.payload);
}

"####);
    skeptic::rt::compile_test(r#"/Users/eeisaman/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/ply-rs-0.1.3"#, r#"/Users/eeisaman/Documents/SIGMA PRODUCTIONS/g2m/target/debug/build/ply-rs-ae7256cd1d80cafc/out"#, r#"aarch64-apple-darwin"#, s);
}

#[test] fn readme_sect_getting_started_line_68() {
    let s = &format!(r####"
{}"####, r####"extern crate ply_rs;
use ply_rs::ply::{ Ply, DefaultElement };
use ply_rs::writer::{ Writer };

/// Demonstrates simplest use case for reading from a file.
fn main() {
    // set up a target, could also be a file
    let mut buf = Vec::<u8>::new();

    // crete a ply objet
    let mut ply = Ply::<DefaultElement>::new();

    // set up a writer
    let w = Writer::new();
    let written = w.write_ply(&mut buf, &mut ply).unwrap();
    println!("{} bytes written", written);
    println!("buffer size: {}", buf.len());

    // proof that data has been read

    // We can use `from_utf8` since PLY files only contain ascii characters
    let output = String::from_utf8(buf).unwrap();
    println!("Written data:\n{}", output);
}
"####);
    skeptic::rt::run_test(r#"/Users/eeisaman/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/ply-rs-0.1.3"#, r#"/Users/eeisaman/Documents/SIGMA PRODUCTIONS/g2m/target/debug/build/ply-rs-ae7256cd1d80cafc/out"#, r#"aarch64-apple-darwin"#, s);
}

