import json
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

credentials = json.loads(Path("/tmp/acceptance-accounting.json").read_text())
started = time.monotonic()
for attempt in range(10):
    try:
        request = Request("http://127.0.0.1:8000/api/method/crypto_payroll.api.export_compliance",
                          data=b'{"filters":{},"format":"csv"}', headers={
                              "Host": "accounting-acceptance.localhost", "Content-Type": "application/json",
                              "Authorization": f"token {credentials['api_key']}:{credentials['api_secret']}",
                          })
        with urlopen(request, timeout=10) as response:
            raise RuntimeError("Disposable site unexpectedly returned a populated export")
    except HTTPError as error:
        payload = json.loads(error.read(1024 * 1024))
        expected = "frappe.exceptions.ValidationError: no submitted confirmed payments match the compliance filters"
        if error.code == 417 and payload.get("exception") == expected:
            print(f"Accounting HTTP/auth/query readiness passed (expected empty-data response) in {time.monotonic() - started:.2f}s.")
            break
        raise RuntimeError(f"Accounting readiness failed with HTTP {error.code}") from None
    except (URLError, TimeoutError):
        pass
    time.sleep(1)
else:
    raise RuntimeError("Accounting HTTP endpoint did not become ready within 10 attempts (10s each).")
