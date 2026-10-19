import json
from hashlib import sha256
from decimal import Decimal

import frappe

frappe.init(site="accounting-acceptance.localhost")
frappe.connect()
records = []
try:
    assert frappe.db.count("Crypto Payment Batch") == 3
    assert frappe.db.count("Journal Entry") == 3
    for external_id, expected_lines in [
        ("acceptance-payroll-v1", 2),
        ("acceptance-send-v1", 1),
        ("acceptance-lost-reply-v1", 1),
    ]:
        sources = frappe.get_all("Crypto Payment Batch", filters={"external_id": external_id},
                                fields=["name", "docstatus", "journal_entry"])
        journals = frappe.get_all("Journal Entry", filters={"crypto_batch_id": external_id},
                                 fields=["name", "docstatus", "total_debit", "total_credit"])
        assert len(sources) == len(journals) == 1, external_id
        source = frappe.get_doc("Crypto Payment Batch", sources[0].name)
        journal = frappe.get_doc("Journal Entry", journals[0].name)
        expected_total = Decimal("123.45") * expected_lines
        assert source.docstatus == journal.docstatus == 1
        assert source.journal_entry == journal.name
        assert journal.crypto_tx_hash == source.tx_hash
        assert len(source.payments) == expected_lines
        assert source.chain == "ckb:testnet"
        assert source.tx_hash == "0x" + sha256(external_id.encode()).hexdigest()
        assert source.fiat_currency == "USD"
        assert int(source.fiat_total_minor) == 12345 * expected_lines
        for payment in source.payments:
            assert payment.fiat_currency == "USD" and int(payment.fiat_minor) == 12345
            assert payment.crypto_asset == "CKB" and int(payment.crypto_value) == 7000000000
            assert payment.crypto_decimals == 8
        assert Decimal(str(journal.total_debit)) == Decimal(str(journal.total_credit)) == expected_total
        assert sum(Decimal(str(entry.debit)) for entry in journal.accounts) == expected_total
        assert sum(Decimal(str(entry.credit)) for entry in journal.accounts) == expected_total
        assert {entry.account for entry in journal.accounts} == {
            "Salary or Wage Expense - CPT", "Crypto Treasury Asset - CPT",
        }
        assert sum(Decimal(str(entry.debit)) for entry in journal.accounts
                   if entry.account == "Salary or Wage Expense - CPT") == expected_total
        assert sum(Decimal(str(entry.credit)) for entry in journal.accounts
                   if entry.account == "Crypto Treasury Asset - CPT") == expected_total
        records.append({"external_id": external_id, "sources": sources, "journals": journals,
                        "lines": len(source.payments)})
    assert "Accounts User" in frappe.get_roles("accounting@example.invalid")
    assert "System Manager" not in frappe.get_roles("accounting@example.invalid")
    assert not {"Accounts User", "Accounts Manager", "System Manager"}.intersection(
        frappe.get_roles("unprivileged@example.invalid"))
    print(json.dumps({"passed": True, "source_count": 3, "journal_count": 3, "line_count": 4,
                      "records": records}, default=str, indent=2))
finally:
    frappe.destroy()
