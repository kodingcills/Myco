"""Test-only: write a MOCK .xlsx from a JSON cell map with openpyxl (#682).

    python3 -I upstream_mock_xlsx.py <cells.json> <out.xlsx>

cells.json maps A1 references on the first sheet to a string or a number. The workbooks are
scripted end states (labelled MOCK by the test); they are never upstream gold files.
"""

import json
import sys

import openpyxl


def main():
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        cells = json.load(f)
    book = openpyxl.Workbook()
    sheet = book.active
    for ref, value in cells.items():
        sheet[ref] = value
    book.save(sys.argv[2])


if __name__ == "__main__":
    main()
