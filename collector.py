#!/usr/bin/env python3
"""
Data collector - samples Glances API every 60s and stores in SQLite
Also tracks OpenClaw token usage for 24hr stats
"""
import sqlite3
import urllib.request
import subprocess
import shutil
import json
import time
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "history.db"
GLANCES_API = "http://localhost:61208/api/4"
INTERVAL = 60  # seconds

def find_openclaw():
    """Auto-detect openclaw binary path"""
    # Check common locations
    candidates = [
        shutil.which("openclaw"),  # Check PATH first
        Path.home() / ".nvm/versions/node" / f"v{get_node_version()}" / "bin/openclaw",
        Path("/usr/local/bin/openclaw"),
        Path("/opt/homebrew/bin/openclaw"),
    ]
    
    for p in candidates:
        if p and Path(p).exists():
            return Path(p)
    
    return None

def get_node_version():
    """Get current node version for nvm path detection"""
    try:
        result = subprocess.run(["node", "-v"], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            return result.stdout.strip()  # Returns like "v24.13.0"
    except:
        pass
    return "v18.0.0"  # Fallback

OPENCLAW_PATH = find_openclaw()

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS metrics (
            timestamp INTEGER PRIMARY KEY,
            cpu REAL,
            ram REAL,
            disk REAL,
            load1 REAL,
            load5 REAL,
            load15 REAL,
            net_down REAL,
            net_up REAL
        )
    """)
    # OpenClaw stats table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS openclaw_stats (
            timestamp INTEGER PRIMARY KEY,
            sessions INTEGER,
            tokens INTEGER,
            status TEXT
        )
    """)
    # Process metrics table for historical tracking
    conn.execute("""
        CREATE TABLE IF NOT EXISTS process_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER,
            name TEXT,
            cpu REAL,
            ram_mb REAL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ts ON metrics(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_oc_ts ON openclaw_stats(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_proc_ts ON process_metrics(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_proc_name ON process_metrics(name)")
    conn.commit()
    conn.close()
    print(f"📊 Database initialized: {DB_PATH}")

def fetch_json(endpoint):
    try:
        with urllib.request.urlopen(f"{GLANCES_API}/{endpoint}", timeout=5) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"⚠️  Failed to fetch {endpoint}: {e}")
        return None

def collect_sample():
    cpu = fetch_json("cpu")
    mem = fetch_json("mem")
    disk = fetch_json("fs")
    load = fetch_json("load")
    net = fetch_json("network")
    
    if not all([cpu, mem, disk, load, net]):
        return None
    
    # Calculate network totals
    net_down = sum(i.get("bytes_recv_rate_per_sec", 0) for i in net if i.get("interface_name") != "lo")
    net_up = sum(i.get("bytes_sent_rate_per_sec", 0) for i in net if i.get("interface_name") != "lo")
    
    # Get main disk
    main_disk = next((d for d in disk if d.get("mnt_point") == "/"), disk[0] if disk else {})
    
    return {
        "timestamp": int(time.time()),
        "cpu": cpu.get("total", 0),
        "ram": mem.get("percent", 0),
        "disk": main_disk.get("percent", 0),
        "load1": load.get("min1", 0),
        "load5": load.get("min5", 0),
        "load15": load.get("min15", 0),
        "net_down": net_down,
        "net_up": net_up
    }

def save_sample(data):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        INSERT OR REPLACE INTO metrics 
        (timestamp, cpu, ram, disk, load1, load5, load15, net_down, net_up)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        data["timestamp"], data["cpu"], data["ram"], data["disk"],
        data["load1"], data["load5"], data["load15"],
        data["net_down"], data["net_up"]
    ))
    conn.commit()
    conn.close()

def collect_openclaw_stats():
    """Fetch OpenClaw status and return stats"""
    if not OPENCLAW_PATH:
        return None  # OpenClaw not installed
    
    try:
        result = subprocess.run(
            [str(OPENCLAW_PATH), "status", "--json"],
            capture_output=True,
            text=True,
            timeout=15
        )
        if result.returncode != 0:
            return None
        
        status = json.loads(result.stdout)
        sessions = status.get("sessions", {})
        recent = sessions.get("recent", [])
        
        # Sum tokens from recent sessions
        total_tokens = sum(s.get("totalTokens", 0) for s in recent[:10])
        
        return {
            "timestamp": int(time.time()),
            "sessions": sessions.get("count", 0),
            "tokens": total_tokens,
            "status": "running"
        }
    except Exception as e:
        print(f"⚠️  Failed to fetch OpenClaw stats: {e}")
        return None

def save_openclaw_stats(data):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        INSERT OR REPLACE INTO openclaw_stats 
        (timestamp, sessions, tokens, status)
        VALUES (?, ?, ?, ?)
    """, (data["timestamp"], data["sessions"], data["tokens"], data["status"]))
    conn.commit()
    conn.close()

def collect_top_processes():
    """Get top processes by CPU and RAM from Glances"""
    procs = fetch_json("processlist")
    if not procs:
        return []
    
    # Get top 10 by CPU usage (handle None values)
    top_procs = []
    seen = set()
    
    # Filter out None values and sort
    valid_procs = [p for p in procs if p and p.get("cpu_percent") is not None]
    sorted_procs = sorted(valid_procs, key=lambda x: x.get("cpu_percent", 0) or 0, reverse=True)
    
    for p in sorted_procs[:15]:
        name = p.get("name", "unknown")
        if not name:
            continue
        # Dedupe by name (aggregate same process)
        if name in seen:
            continue
        seen.add(name)
        
        mem_info = p.get("memory_info")
        ram_mb = 0
        if mem_info:
            # memory_info can be a dict with 'rss' or a list
            if isinstance(mem_info, dict):
                ram_mb = mem_info.get("rss", 0) / (1024 * 1024)
            elif isinstance(mem_info, (list, tuple)) and len(mem_info) > 0:
                ram_mb = mem_info[0] / (1024 * 1024)
        
        top_procs.append({
            "name": name,
            "cpu": p.get("cpu_percent", 0) or 0,
            "ram_mb": ram_mb
        })
        
        if len(top_procs) >= 10:
            break
    
    return top_procs

def save_process_metrics(timestamp, processes):
    conn = sqlite3.connect(DB_PATH)
    for p in processes:
        conn.execute("""
            INSERT INTO process_metrics (timestamp, name, cpu, ram_mb)
            VALUES (?, ?, ?, ?)
        """, (timestamp, p["name"], p["cpu"], p["ram_mb"]))
    conn.commit()
    conn.close()

def cleanup_old_data():
    """Keep only last 90 days of data (7 days for process metrics to save space)"""
    cutoff_90d = int(time.time()) - (90 * 24 * 60 * 60)
    cutoff_7d = int(time.time()) - (7 * 24 * 60 * 60)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM metrics WHERE timestamp < ?", (cutoff_90d,))
    conn.execute("DELETE FROM openclaw_stats WHERE timestamp < ?", (cutoff_90d,))
    conn.execute("DELETE FROM process_metrics WHERE timestamp < ?", (cutoff_7d,))
    conn.commit()
    conn.close()

def main():
    print("🖥️  Mac Mini Metrics Collector")
    print(f"   Sampling every {INTERVAL}s")
    print(f"   Database: {DB_PATH}")
    if OPENCLAW_PATH:
        print(f"   OpenClaw: {OPENCLAW_PATH}")
    else:
        print("   OpenClaw: not found (stats disabled)")
    print()
    
    init_db()
    
    sample_count = 0
    while True:
        data = collect_sample()
        if data:
            save_sample(data)
            sample_count += 1
            ts = datetime.now().strftime("%H:%M:%S")
            print(f"[{ts}] CPU: {data['cpu']:.1f}% | RAM: {data['ram']:.1f}% | Samples: {sample_count}")
            
            # Collect top processes every sample
            procs = collect_top_processes()
            if procs:
                save_process_metrics(data["timestamp"], procs)
                print(f"        📊 Tracked {len(procs)} processes")
        
        # Collect OpenClaw stats every 5 minutes (every 5 samples)
        if sample_count % 5 == 0:
            oc_data = collect_openclaw_stats()
            if oc_data:
                save_openclaw_stats(oc_data)
                print(f"        🦞 OpenClaw: {oc_data['sessions']} sessions, {oc_data['tokens']} tokens")
        
        # Cleanup old data every hour
        if sample_count % 60 == 0:
            cleanup_old_data()
        
        time.sleep(INTERVAL)

if __name__ == "__main__":
    main()
