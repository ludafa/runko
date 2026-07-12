---
name: pdf-fill
description: Fill PDF form fields programmatically using pdftk or an equivalent library, given a template PDF and a set of field values.
license: MIT
---

# PDF Fill

This skill fills form fields in a PDF template without opening a PDF editor.

## Usage

1. Read `reference.md` in this skill's attached files for the field name conventions used by the template.
2. Call the `pdftk` CLI (or an equivalent library) with the field values as a FDF/XFDF data file.
3. Verify the output PDF opens correctly and every field is populated.
