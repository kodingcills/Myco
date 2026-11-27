# Real LibreOffice output for the xlsx byte grammar

Two workbooks saved by LibreOffice Calc 24.2.7.2 (the build in the cloud container and on the
trial VM) from the CSVs next to them, with a throwaway profile:

    soffice -env:UserInstallation=file://<tmp>/profile --headless \
      --convert-to xlsx --outdir <tmp> escapes.csv tab-newline.csv

then renamed `<name>.lo.xlsx`. `manifest.json` pins each file's SHA-256. Re-running gives
different bytes (LibreOffice stamps docProps) but the same XML shapes.

They are the evidence for the reference rule of the raw-byte pre-scan
(`src/gate/xlsx-prescan.ts`, `docs/gate/xlsx-byte-grammar.md`):

- `escapes.lo.xlsx`: LibreOffice writes all five predefined escapes in shared strings
  (`A&amp;B`, `x&lt;y&gt;z`, `q&quot;uote`, `it&apos;s`), raw UTF-8 for non-ASCII text, and
  `xml:space="preserve"` on every `<t>`. The whole workbook passes the pre-scan and reads to
  the CSV's text.
- `tab-newline.lo.xlsx`: LibreOffice writes a tab as `&#9;` and a line break as `&#10;`. The
  pre-scan refuses every numeric reference (XLSX_PRESCAN_ENTITY), so this workbook is
  `uncertain`, never verified: a deliberate fail-closed choice, documented, not an accident.

`test/gate/xlsx-lo-grammar.test.ts` checks both.
