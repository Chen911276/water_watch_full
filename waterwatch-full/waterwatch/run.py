"""啟動水見：python run.py → 打開 http://127.0.0.1:8000"""
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn  # noqa: E402

from server import config  # noqa: E402
from server.main import app  # noqa: E402

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("apscheduler").setLevel(logging.WARNING)
    print(f"\n💧 水見啟動中… 打開瀏覽器輸入：http://127.0.0.1:{config.PORT}\n   （按 Ctrl + C 停止）\n")
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")
