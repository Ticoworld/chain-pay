import json
import os
from pathlib import Path

import frappe
from frappe.core.doctype.user.user import generate_keys

frappe.init(site="accounting-acceptance.localhost")
frappe.connect()
try:
    frappe.set_user("Administrator")
    for suffix, roles in [("accounting", ["Accounts User"]), ("unprivileged", ["Employee"])]:
        email = f"{suffix}@example.invalid"
        frappe.get_doc({
            "doctype": "User", "email": email, "first_name": "Synthetic acceptance",
            "send_welcome_email": 0, "roles": [{"role": role} for role in roles],
        }).insert(ignore_permissions=True)
        credentials = generate_keys(email)
        credentials["api_key"] = frappe.db.get_value("User", email, "api_key")
        frappe.db.commit()
        descriptor = os.open(f"/tmp/acceptance-{suffix}.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf8") as target:
            json.dump(credentials, target)
    Path("/tmp/acceptance-date").write_text(str(frappe.utils.today()), encoding="utf8")
finally:
    frappe.destroy()
print("Disposable role-limited API users prepared inside the isolated container.")
