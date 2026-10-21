import json
import re
from collections import deque
from pathlib import Path


def summarize(lines):
    """Keep diagnostic context without copying arbitrary server text.

    >>> summarize(['Authorization: OMITTED', 'ValueError: OMITTED'])
    [{'exceptionType': 'ValueError'}]
    >>> summarize(['"GET /api/method/ping?key=OMITTED HTTP/1.1" 401 -'])
    []
    >>> summarize(['\\x1b[31m"POST /api/method/ping HTTP/1.1" 403 -\\x1b[0m'])
    [{'method': 'POST', 'path': '/api/method/ping', 'status': 403}]
    >>> len(summarize(['ValueError: OMITTED'] * 100))
    30
    """
    events = []
    for line in lines:
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line)
        access = re.search(r'"(GET|POST) (/api/method/[a-zA-Z_.]+) HTTP/[\d.]+" (\d{3})', line)
        exception = re.match(r"^([a-zA-Z_.]*(?:Error|Exception)):", line)
        if access:
            events.append({"method": access[1], "path": access[2], "status": int(access[3])})
        elif exception:
            events.append({"exceptionType": exception[1]})
    return events[-30:]


if __name__ == "__main__":
    source = Path("/tmp/acceptance-http.log")
    with source.open(encoding="utf-8", errors="replace") as log:
        events = summarize(deque(log, maxlen=200))
    print(json.dumps({"events": events, "note": "Only method/path/status and exception classes; bodies, headers and messages omitted."}, indent=2))
