"""A protocol example only: copies original demo art, does not call AI."""
import sys
import json
import shutil
from pathlib import Path

request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8") if len(sys.argv) > 1 else sys.stdin.read())
output_dir = Path(request["output_directory"])
output_dir.mkdir(parents=True, exist_ok=True)
result = output_dir / "demo-result.png"
shutil.copyfile(Path(__file__).with_name("demo-reference.png"), result)
print(json.dumps({"output": {"path": str(result.resolve())}, "demo": True}, ensure_ascii=False))
