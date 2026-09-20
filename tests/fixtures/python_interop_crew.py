#!/usr/bin/env python3
"""Python LXMF crew client fixture for the interop smoketest.

Stands in for the boat's crew member (Sideband or any other Python RNS/LXMF
client): connects to the test rnsd over a TCP interface like a mesh peer,
brings up a real Python LXMF router, announces itself periodically, pings the
Signal K node's lxmf.delivery destination, and prints every message it
receives as a JSON line on stdout.

Protocol (all JSON lines):
  -> {"type": "ready", "identity": "<hex>", "dest": "<hex>"}   once, after
     the crew's lxmf.delivery destination exists; identity/dest hashes are
     also written to <workdir>/crew.json so the Node side can configure the
     crew member without parsing stdout.
  <- {"type": "plugin", "dest": "<hex>"}                       the Node side
     writes <workdir>/plugin.json with the Signal K node's lxmf.delivery
     hash; once it appears the crew starts pinging every few seconds.
  -> {"type": "message", "title": ..., "content": ...}        for every
     delivered LXMF message (ping replies, telemetry snapshots, alerts).

Exits when stdin closes or SIGTERM arrives.
"""
import json
import os
import sys
import threading
import time

import RNS
import LXMF

CONFIG_DIR = sys.argv[1]
WORK_DIR = sys.argv[2]

os.makedirs(WORK_DIR, exist_ok=True)
RNS.loglevel = RNS.LOG_CRITICAL

reticulum = RNS.Reticulum(configdir=CONFIG_DIR)
router = LXMF.LXMRouter(storagepath=os.path.join(WORK_DIR, "crew-storage"), autopeer=False)
identity = RNS.Identity()
crew_dest = router.register_delivery_identity(identity, "Crew Client")

received = []
received_lock = threading.Lock()


def incoming(message):
    content = (
        message.content.decode(errors="replace")
        if isinstance(message.content, bytes)
        else (message.content or "")
    )
    title = (
        message.title.decode(errors="replace")
        if isinstance(message.title, bytes)
        else (message.title or "")
    )
    with received_lock:
        received.append({"type": "message", "title": title, "content": content})


router.register_delivery_callback(incoming)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


emit(
    {
        "type": "ready",
        "identity": RNS.hexrep(identity.hash, delimit=False),
        "dest": RNS.hexrep(crew_dest.hash, delimit=False),
    }
)
with open(os.path.join(WORK_DIR, "crew.json"), "w") as f:
    json.dump(
        {
            "identity": RNS.hexrep(identity.hash, delimit=False),
            "dest": RNS.hexrep(crew_dest.hash, delimit=False),
        },
        f,
    )

router.announce(crew_dest.hash)

running = True


def reannouncer():
    # Announce like a mobile client: periodically, so a late-starting peer
    # (the plugin) still learns our identity and ratchet.
    while running:
        time.sleep(5)
        try:
            router.announce(crew_dest.hash)
        except Exception:
            pass


def pinger():
    # Wait for the plugin's lxmf.delivery hash, then ping every few seconds.
    plugin_json = os.path.join(WORK_DIR, "plugin.json")
    js_dest = None
    while running and js_dest is None:
        if os.path.exists(plugin_json):
            with open(plugin_json) as f:
                js_dest = bytes.fromhex(json.load(f)["dest"])
        else:
            time.sleep(0.5)
    if js_dest is None:
        return
    js_identity = None
    while running and js_identity is None:
        js_identity = RNS.Identity.recall(js_dest)
        if js_identity is None:
            try:
                RNS.Transport.request_path(js_dest)
            except Exception:
                pass
            time.sleep(1)
    if js_identity is None:
        return
    js_out = RNS.Destination(
        js_identity, RNS.Destination.OUT, RNS.Destination.SINGLE, "lxmf", "delivery"
    )
    while running:
        time.sleep(5)
        try:
            msg = LXMF.LXMessage(
                destination=js_out,
                source=crew_dest,
                content="ping",
                desired_method=LXMF.LXMessage.OPPORTUNISTIC,
            )
            router.handle_outbound(msg)
        except Exception:
            pass


threading.Thread(target=reannouncer, daemon=True).start()
threading.Thread(target=pinger, daemon=True).start()


def flusher():
    # Forward delivered messages to stdout as they arrive.
    seen = 0
    while running:
        with received_lock:
            batch = received[seen:]
            seen = len(received)
        for item in batch:
            emit(item)
        time.sleep(0.5)


threading.Thread(target=flusher, daemon=True).start()

try:
    while not sys.stdin.closed:
        time.sleep(0.5)
except Exception:
    pass
running = False
