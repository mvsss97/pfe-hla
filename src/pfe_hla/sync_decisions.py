import os
import sys
import json
import urllib.request
import logging

from .library import Library

logger = logging.getLogger(__name__)

def run_sync_decisions():
    worker_url = os.environ.get("WORKER_URL")
    worker_secret = os.environ.get("WORKER_SECRET")
    
    if not worker_url or not worker_secret:
        logger.warning("WORKER_URL or WORKER_SECRET not set. Skipping sync.")
        return

    url = f"{worker_url}/sync-decisions?secret={worker_secret}"
    logger.info(f"Syncing decisions from {worker_url} ...")
    
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode('utf-8'))
    except Exception as e:
        logger.error(f"Failed to fetch decisions: {e}")
        return

    if not data:
        logger.info("No new decisions found.")
        return

    db_path = os.environ.get("PFE_DB_PATH", "data/pfe_hla.db")
    library = Library(db_path)
    
    count = 0
    for paper_id, decision_data in data.items():
        action = decision_data.get("action")
        logger.info(f"Applying decision to {paper_id}: {action}")
        
        # update SQLite
        with library.conn:
            if action == "keep":
                library.conn.execute("UPDATE papers SET status = 'included' WHERE id = ?", (paper_id,))
            elif action == "reject":
                library.conn.execute("UPDATE papers SET status = 'excluded' WHERE id = ?", (paper_id,))
        count += 1
        
    logger.info(f"Successfully applied {count} decisions from Telegram.")
