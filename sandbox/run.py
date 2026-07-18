import os
from e2b import Sandbox

from dotenv import load_dotenv

load_dotenv()
template_id = os.environ["CUBE_TEMPLATE_ID"]

sb = Sandbox.create(
  template=template_id,
  timeout = 3600,
)

url = f"https://{sb.get_host(8765)}"
print(f"请打开浏览器访问: {url}")
