#!/usr/bin/env python3
"""
Denise Mail: a retro, local-only email program for Gmail.

* Runs a tiny web server on YOUR computer only (127.0.0.1) and opens it in your browser.
* Talks to Gmail directly over IMAP (reading) and SMTP (sending) using a Google App Password.
* Nothing is hosted anywhere. Your password is kept in memory only, never written to disk,
  and is forgotten when you sign off or quit.
* No third-party packages: just the Python standard library.

Run:  python3 denise_mail.py          (add --demo to skip sign-in and use the demo mailbox)
"""
import argparse
import email
import email.policy
import email.utils
import html
import imaplib
import json
import mimetypes
import os
import re
import secrets
import smtplib
import ssl
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
PER_PAGE = 40
MAX_BODY = 4 * 1024 * 1024  # largest request we accept (4 MB)

# --------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------
KIND_ORDER = ["inbox", "starred", "important", "sent", "drafts", "all", "spam", "trash"]
KIND_LABEL = {"inbox": "Inbox", "starred": "Starred", "important": "Important", "sent": "Sent Mail",
              "drafts": "Drafts", "all": "All Mail", "spam": "Junk Mail", "trash": "Trash"}
SPECIAL_USE = {"\\sent": "sent", "\\drafts": "drafts", "\\trash": "trash", "\\junk": "spam",
               "\\flagged": "starred", "\\all": "all", "\\important": "important"}


def iso(dt):
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_date(value):
    try:
        return email.utils.parsedate_to_datetime(str(value))
    except Exception:
        return None


def addr_info(value):
    """Return (display name, address) from a header value."""
    name, addr = email.utils.parseaddr(str(value or ""))
    return (name or "").strip(), (addr or "").strip()


def addr_list(value):
    out = []
    for name, addr in email.utils.getaddresses([str(value or "")]):
        if addr:
            out.append({"name": name.strip(), "address": addr.strip()})
    return out


def imap_quote(name):
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def clean_header_text(s):
    return re.sub(r"[\r\n]+", " ", str(s or "")).strip()


def safe_filename(name):
    name = os.path.basename(str(name or "attachment")).replace("\r", "").replace("\n", "")
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name).strip() or "attachment"
    return name[:150]


def part_text(part):
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        return payload.decode(part.get_content_charset() or "utf-8", errors="replace")


def parse_full_message(raw):
    """Parse raw RFC822 bytes into the JSON-friendly dict the UI uses."""
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    text_part = msg.get_body(preferencelist=("plain",))
    html_part = msg.get_body(preferencelist=("html",))
    text = part_text(text_part) if text_part is not None else ""
    html_body = part_text(html_part) if html_part is not None else ""
    attachments = []
    for i, part in enumerate(msg.iter_attachments()):
        payload = part.get_payload(decode=True) or b""
        attachments.append({"index": i, "filename": safe_filename(part.get_filename() or "attachment"),
                            "contentType": part.get_content_type(), "size": len(payload)})
    return {
        "subject": clean_header_text(msg["subject"]) or "(no subject)",
        "from": addr_list(msg["from"]), "to": addr_list(msg["to"]), "cc": addr_list(msg["cc"]),
        "replyTo": addr_list(msg["reply-to"]), "date": iso(parse_date(msg["date"])),
        "messageId": clean_header_text(msg["message-id"]), "references": clean_header_text(msg["references"]),
        "text": text, "html": html_body, "attachments": attachments,
    }


def nth_attachment(raw, index):
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    for i, part in enumerate(msg.iter_attachments()):
        if i == index:
            return (safe_filename(part.get_filename() or "attachment"), part.get_content_type(),
                    part.get_payload(decode=True) or b"")
    raise KeyError("attachment not found")


def build_outgoing(sender, data):
    msg = EmailMessage()
    msg["From"] = sender
    for field, key in (("To", "to"), ("Cc", "cc"), ("Bcc", "bcc")):
        value = clean_header_text(data.get(key, ""))
        if value:
            msg[field] = value
    msg["Subject"] = clean_header_text(data.get("subject", "")) or "(no subject)"
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain="denise-mail.local")
    if data.get("inReplyTo"):
        msg["In-Reply-To"] = clean_header_text(data["inReplyTo"])
    if data.get("references"):
        msg["References"] = clean_header_text(data["references"])
    msg.set_content(str(data.get("body", "")))
    return msg


# --------------------------------------------------------------------------------------
# Gmail backend (IMAP + SMTP)
# --------------------------------------------------------------------------------------
class GmailBackend:
    IMAP_HOST = "imap.gmail.com"
    SMTP_HOST = "smtp.gmail.com"
    demo = False

    def __init__(self, address, password, imap_factory=None, smtp_factory=None):
        self.address = address
        self._password = password
        self.lock = threading.RLock()
        self._imap_factory = imap_factory or self._default_imap
        self._smtp_factory = smtp_factory or self._default_smtp
        self.conn = None
        self._folders = None
        self._kind_to_name = {}
        self._contacts = {}
        self._connect()

    # ---- connection handling
    def _default_imap(self):
        return imaplib.IMAP4_SSL(self.IMAP_HOST, 993, ssl_context=ssl.create_default_context(), timeout=30)

    def _default_smtp(self):
        return smtplib.SMTP_SSL(self.SMTP_HOST, 465, context=ssl.create_default_context(), timeout=30)

    def _connect(self):
        self.conn = self._imap_factory()
        self.conn.login(self.address, self._password)
        self._selected = None

    def _run(self, fn):
        """Run fn(conn); reconnect once if Gmail dropped the connection."""
        with self.lock:
            try:
                return fn(self.conn)
            except (imaplib.IMAP4.abort, OSError, ssl.SSLError):
                self._connect()
                return fn(self.conn)

    def close(self):
        self._password = None
        try:
            with self.lock:
                if self.conn:
                    self.conn.logout()
        except Exception:
            pass

    def _select(self, conn, folder, readonly):
        typ, data = conn.select(imap_quote(folder), readonly=readonly)
        if typ != "OK":
            raise ValueError("Could not open that folder.")
        self._selected = (folder, readonly)

    # ---- folders
    def folders(self):
        def go(conn):
            typ, data = conn.list()
            if typ != "OK":
                raise ValueError("Could not list folders.")
            found = []
            for item in data or []:
                if not item:
                    continue
                line = item.decode("utf-8", "replace") if isinstance(item, bytes) else str(item)
                m = re.match(r'\((?P<flags>[^)]*)\)\s+(?:"(?P<delim>[^"]*)"|NIL)\s+(?P<name>.+)$', line)
                if not m:
                    continue
                flags = [f.lower() for f in m.group("flags").split()]
                name = m.group("name").strip()
                if name.startswith('"') and name.endswith('"'):
                    name = name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
                if "\\noselect" in flags:
                    continue
                kind = "inbox" if name.upper() == "INBOX" else next((SPECIAL_USE[f] for f in flags if f in SPECIAL_USE), "label")
                found.append({"id": name, "kind": kind, "label": KIND_LABEL.get(kind, name)})
            order = {k: i for i, k in enumerate(KIND_ORDER)}
            found.sort(key=lambda f: (order.get(f["kind"], 99), f["label"].lower()))
            self._kind_to_name = {}
            for f in found:
                self._kind_to_name.setdefault(f["kind"], f["id"])
            for f in found:
                if f["kind"] in ("inbox", "spam", "drafts"):
                    f["unread"] = self._status(conn, f["id"], "UNSEEN")
            self._folders = found
            return found
        return self._run(go)

    def _status(self, conn, folder, item):
        try:
            typ, data = conn.status(imap_quote(folder), "(%s)" % item)
            if typ == "OK" and data and data[0]:
                m = re.search(r"%s (\d+)" % item, data[0].decode("utf-8", "replace"))
                return int(m.group(1)) if m else 0
        except Exception:
            pass
        return 0

    def unread_count(self):
        return self._run(lambda conn: self._status(conn, "INBOX", "UNSEEN"))

    def _trash_name(self):
        if not self._kind_to_name:
            self.folders()
        return self._kind_to_name.get("trash", "[Gmail]/Trash")

    def _kind_of(self, folder):
        if not self._folders:
            self.folders()
        for f in self._folders or []:
            if f["id"] == folder:
                return f["kind"]
        return "label"

    # ---- message lists
    def list_messages(self, folder, page=0, query=""):
        def go(conn):
            self._select(conn, folder, True)
            if query:
                q = re.sub(r"[\r\n]+", " ", query).replace("\\", "\\\\").replace('"', '\\"')
                typ, data = conn.uid("SEARCH", None, "X-GM-RAW", '"%s"' % q)
            else:
                typ, data = conn.uid("SEARCH", None, "ALL")
            if typ != "OK":
                raise ValueError("The search did not work. Try different words.")
            uids = [int(x) for x in (data[0] or b"").split()]
            uids.sort(reverse=True)
            total = len(uids)
            start = max(0, page) * PER_PAGE
            chunk = uids[start:start + PER_PAGE]
            items = self._fetch_headers(conn, chunk) if chunk else []
            items.sort(key=lambda it: it["uid"], reverse=True)
            return items, total
        return self._run(go)

    def _note_contact(self, name, address):
        key = address.lower()
        prev_name, count = self._contacts.get(key, ("", 0))
        self._contacts[key] = (name or prev_name, count + 1)

    def _fetch_headers(self, conn, uids):
        spec = "(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE)])"
        typ, data = conn.uid("FETCH", ",".join(str(u) for u in uids), spec)
        if typ != "OK":
            raise ValueError("Could not fetch messages.")
        items = []
        raw_items = list(data or [])
        for i, entry in enumerate(raw_items):
            if not isinstance(entry, tuple):
                continue
            meta = entry[0].decode("utf-8", "replace")
            if i + 1 < len(raw_items) and isinstance(raw_items[i + 1], bytes):
                meta += " " + raw_items[i + 1].decode("utf-8", "replace")
            m_uid = re.search(r"UID (\d+)", meta)
            if not m_uid:
                continue
            m_flags = re.search(r"FLAGS \(([^)]*)\)", meta)
            flags = [f.lower() for f in (m_flags.group(1).split() if m_flags else [])]
            hdr = email.message_from_bytes(entry[1], policy=email.policy.default)
            sender_name, sender_addr = addr_info(hdr["from"])
            for a in addr_list(hdr["to"]):
                if a["address"].lower() != self.address.lower():
                    self._note_contact(a["name"], a["address"])
            if sender_addr and sender_addr.lower() != self.address.lower():
                self._note_contact(sender_name, sender_addr)
            ctype = str(hdr["content-type"] or "").lower()
            dt = parse_date(hdr["date"])
            items.append({
                "uid": int(m_uid.group(1)),
                "fromName": sender_name or sender_addr, "fromAddress": sender_addr,
                "to": clean_header_text(hdr["to"]),
                "subject": clean_header_text(hdr["subject"]) or "(no subject)",
                "date": iso(dt),
                "unread": "\\seen" not in flags, "starred": "\\flagged" in flags,
                "attachment": "multipart/mixed" in ctype,
            })
        return items

    # ---- single messages
    def _fetch_raw(self, conn, folder, uid, readonly=True):
        self._select(conn, folder, readonly)
        typ, data = conn.uid("FETCH", str(int(uid)), "(FLAGS BODY.PEEK[])")
        if typ != "OK" or not data or not isinstance(data[0], tuple):
            raise ValueError("That message could not be found.")
        meta = data[0][0].decode("utf-8", "replace")
        if len(data) > 1 and isinstance(data[1], bytes):
            meta += " " + data[1].decode("utf-8", "replace")
        m_flags = re.search(r"FLAGS \(([^)]*)\)", meta)
        flags = [f.lower() for f in (m_flags.group(1).split() if m_flags else [])]
        return data[0][1], flags

    def get_message(self, folder, uid):
        def go(conn):
            raw, flags = self._fetch_raw(conn, folder, uid, readonly=False)
            parsed = parse_full_message(raw)
            parsed.update({"uid": int(uid), "folder": folder, "starred": "\\flagged" in flags, "unread": False})
            if "\\seen" not in flags:
                conn.uid("STORE", str(int(uid)), "+FLAGS", "(\\Seen)")
            return parsed
        return self._run(go)

    def get_attachment(self, folder, uid, index):
        def go(conn):
            raw, _ = self._fetch_raw(conn, folder, uid, readonly=True)
            return nth_attachment(raw, int(index))
        return self._run(go)

    def set_flag(self, folder, uid, flag, value):
        name = {"seen": "\\Seen", "starred": "\\Flagged"}[flag]

        def go(conn):
            self._select(conn, folder, False)
            conn.uid("STORE", str(int(uid)), "+FLAGS" if value else "-FLAGS", "(%s)" % name)
        self._run(go)

    def delete(self, folder, uid):
        """Move to Trash (recoverable). Inside Trash, delete forever."""
        in_trash = self._kind_of(folder) == "trash"

        def go(conn):
            self._select(conn, folder, False)
            if not in_trash:
                typ, _ = conn.uid("COPY", str(int(uid)), imap_quote(self._trash_name()))
                if typ != "OK":
                    raise ValueError("Could not move that message to the Trash.")
            conn.uid("STORE", str(int(uid)), "+FLAGS", "(\\Deleted)")
            conn.expunge()
        self._run(go)
        return "deleted forever" if in_trash else "moved to the Trash"

    # ---- sending + contacts
    def send(self, data):
        msg = build_outgoing(self.address, data)
        if not (msg["To"] or msg["Cc"] or msg["Bcc"]):
            raise ValueError("Please add someone to send this to.")
        with self.lock:
            smtp = self._smtp_factory()
            try:
                smtp.login(self.address, self._password)
                smtp.send_message(msg)
            finally:
                try:
                    smtp.quit()
                except Exception:
                    pass

    def contacts(self):
        ranked = sorted(self._contacts.items(), key=lambda kv: -kv[1][1])[:25]
        return [{"address": a, "name": n or a, "count": c} for a, (n, c) in ranked]


# --------------------------------------------------------------------------------------
# Demo backend (no internet, no account)
# --------------------------------------------------------------------------------------
def _demo_messages():
    now = datetime.now(timezone.utc)

    def m(minutes_ago, frm, subject, body, unread=True, starred=False, html_body="", attach=None, to="you@gmail.com"):
        return {"minutes": minutes_ago, "from": frm, "subject": subject, "body": body, "unread": unread,
                "starred": starred, "html": html_body, "attach": attach or [], "to": to}
    return [
        m(3, "Denise Mail Team <hello@poppy-mail.example>", "Welcome to Denise Mail!",
          "Hi there!\n\nYou're using the DEMO mailbox, so none of this is real mail. Try clicking around:\n\n"
          "  * Read messages and reply to them\n  * Write a new message with the Write button\n  * Star things, delete things (they go to the Trash)\n"
          "  * Switch looks with the Look menu: MSN-style or AOL-style\n\nWhen you're ready, sign off and sign on with your real Gmail address and an App Password.\n\n"
          "Happy surfing!\nThe Denise Mail Team", html_body=(
              "<div style='font-family:Verdana,sans-serif'><h2 style='color:#1c5fb8'>Welcome to Denise Mail! \U0001F4EC</h2>"
              "<p>You're using the <b>DEMO</b> mailbox, so none of this is real mail.</p><ul><li>Read, reply, forward</li><li>Star and delete</li><li>Switch looks: MSN-style or AOL-style</li></ul>"
              "<p style='background:#fff3b0;padding:8px;border:1px solid #c9a800'>Pictures from the internet are blocked until you click <b>Show pictures</b>.</p></div>")),
        m(95, "Jamie <jamie.dialup@example.com>", "ttyl?? (are you online tonight)", "hey hey!!\n\nare you gonna be on tonight? my mom said I can use the phone line after 8 as long as nobody calls.\n\nbrb dinner\n\n- Jamie", ),
        m(240, "Geocities Daily <news@pixelweb.example>", "Your homepage 'Cool Cats Fan Club' is now LIVE!",
          "Congratulations!\n\nYour page has had 4 visitors today (3 were you).\n\nTips to grow your site:\n  1. Add a guestbook\n  2. Add a rotating GIF\n  3. Add an 'Under Construction' sign\n\nSee you on the Information Superhighway!"),
        m(600, "Mix Tape Club <djsparkle@example.com>", "Track list for Friday's mix (attached)", "Hi!\n\nAttached is the track list for the party mix. Tell me if I forgot anything good.\n\n- DJ Sparkle",
          attach=[("mixtape-tracklist.txt", "1. Dancing Queen\n2. Wannabe\n3. Bye Bye Bye\n4. Mambo No. 5\n5. Since U Been Gone\n")]),
        m(1500, "Mom <mom@example.com>", "Please don't forward chain letters", "Sweetie, I got that email that says I'll have bad luck if I don't send it to 10 people. I sent it to 11 just to be safe.\n\nLove, Mom", unread=False, starred=True),
        m(3000, "The Retro Gazette <weekly@retro-gazette.example>", "This week: 7 reasons the 90s web was the best web",
          "1. Animated GIFs\n2. Visitor counters\n3. Guestbooks\n4. Web rings\n5. MIDI backgrounds\n6. Away messages\n7. That dial-up sound\n\nUnsubscribe anytime (we'll send a sad GIF).", unread=False),
        m(6000, "Pat <pat@example.com>", "Fwd: Re: Fwd: You won't BELIEVE this!", "forwarded forwarded forwarded\n\n(it's just a picture of a cat)", unread=False),
        m(9000, "Calendar <calendar@example.com>", "Reminder: Study group Thursday at 4:00", "Don't forget your notes! We're meeting in the library, second floor.\n\nBring snacks.", unread=False),
        m(12000, "Travel Deals <deals@trip-surf.example>", "Last minute: 3 nights in a cozy cabin!", "Book now and get a free set of towels!\n\n(Prices subject to change. Towels not guaranteed.)", unread=False),
    ]


class DemoBackend:
    demo = True
    address = "demo@poppy-mail.example"

    ARRIVE_AFTER = 20  # seconds until a surprise message shows up, so you can hear the new-mail chime

    def __init__(self):
        self.lock = threading.RLock()
        self._t0 = time.time()
        self._arrived = False
        now = datetime.now(timezone.utc)
        self.boxes = {"INBOX": [], "Sent": [], "Drafts": [], "Junk": [], "Trash": []}
        self.next_uid = 100
        for spec in reversed(_demo_messages()):  # oldest first, so newer mail gets higher UIDs like real mail
            self._add("INBOX", spec["from"], spec["to"], spec["subject"], spec["body"], now - timedelta(minutes=spec["minutes"]),
                      spec["unread"], spec["starred"], spec["html"], spec["attach"])
        self._add("Junk", "Prize Patrol <winner@totally-real.example>", "demo@poppy-mail.example", "YOU HAVE WON a free screensaver!!!",
                  "Click here to claim your free screensaver. (This is a demo of the Junk folder. Nothing here is real.)", now - timedelta(days=2), True, False, "", [])
        self._add("Sent", "demo@poppy-mail.example", "Mom <mom@example.com>", "Re: Please don't forward chain letters",
                  "Mom, I promise the luck is fine. Love you!", now - timedelta(days=1), False, False, "", [])

    def _add(self, box, frm, to, subject, body, when, unread, starred, html_body, attach):
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = frm, to, subject
        msg["Date"] = email.utils.format_datetime(when)
        msg["Message-ID"] = email.utils.make_msgid(domain="poppy-mail.example")
        msg.set_content(body)
        if html_body:
            msg.add_alternative(html_body, subtype="html")
        for name, content in attach:
            msg.add_attachment(content.encode("utf-8"), maintype="text", subtype="plain", filename=name)
        self.next_uid += 1
        self.boxes[box].append({"uid": self.next_uid, "raw": msg.as_bytes(), "unread": unread, "starred": starred,
                                "when": when, "from": frm, "to": to, "subject": subject, "attach": bool(attach)})

    def close(self):
        pass

    def folders(self):
        def f(i, k, l):
            d = {"id": i, "kind": k, "label": l}
            if k in ("inbox", "spam", "drafts"):
                d["unread"] = sum(1 for x in self.boxes[i] if x["unread"])
            return d
        starred = {"id": "Starred", "kind": "starred", "label": "Starred"}
        return [f("INBOX", "inbox", "Inbox"), starred, f("Sent", "sent", "Sent Mail"), f("Drafts", "drafts", "Drafts"), f("Junk", "spam", "Junk Mail"), f("Trash", "trash", "Trash")]

    def _box(self, folder):
        if folder == "Starred":
            return [dict(x, _box=b) for b, items in self.boxes.items() if b != "Trash" for x in items if x["starred"]]
        if folder not in self.boxes:
            raise ValueError("Could not open that folder.")
        return [dict(x, _box=folder) for x in self.boxes[folder]]

    def unread_count(self):
        if not self._arrived and time.time() - self._t0 > self.ARRIVE_AFTER:
            self._arrived = True
            self._add("INBOX", "Jamie <jamie.dialup@example.com>", self.address, "Surprise! New mail just arrived",
                      "This message showed up while you were using the demo, just so you can hear the new-mail chime.\n\n- Jamie", datetime.now(timezone.utc), True, False, "", [])
        return sum(1 for x in self.boxes["INBOX"] if x["unread"])

    def list_messages(self, folder, page=0, query=""):
        items = self._box(folder)
        if query:
            q = query.lower()
            items = [x for x in items if q in (x["subject"] + " " + x["from"] + " " + x["to"]).lower()]
        items.sort(key=lambda x: x["uid"], reverse=True)
        total = len(items)
        chunk = items[page * PER_PAGE:(page + 1) * PER_PAGE]
        out = []
        for x in chunk:
            name, addr = addr_info(x["from"])
            out.append({"uid": x["uid"], "fromName": name or addr, "fromAddress": addr, "to": x["to"], "subject": x["subject"], "date": iso(x["when"]),
                        "unread": x["unread"], "starred": x["starred"], "attachment": x["attach"]})
        return out, total

    def _find(self, folder, uid):
        for x in self._box(folder):
            if x["uid"] == int(uid):
                return x
        raise ValueError("That message could not be found.")

    def get_message(self, folder, uid):
        x = self._find(folder, uid)
        parsed = parse_full_message(x["raw"])
        parsed.update({"uid": int(uid), "folder": folder, "starred": x["starred"], "unread": False})
        for box in self.boxes.values():
            for y in box:
                if y["uid"] == int(uid):
                    y["unread"] = False
        return parsed

    def get_attachment(self, folder, uid, index):
        return nth_attachment(self._find(folder, uid)["raw"], int(index))

    def set_flag(self, folder, uid, flag, value):
        self._find(folder, uid)
        for box in self.boxes.values():
            for y in box:
                if y["uid"] == int(uid):
                    y["unread" if flag == "seen" else "starred"] = (not value) if flag == "seen" else bool(value)

    def delete(self, folder, uid):
        self._find(folder, uid)
        for name, box in self.boxes.items():
            for y in list(box):
                if y["uid"] == int(uid):
                    box.remove(y)
                    if name == "Trash":
                        return "deleted forever"
                    self.boxes["Trash"].append(y)
                    return "moved to the Trash"
        return "moved to the Trash"

    def send(self, data):
        msg = build_outgoing(self.address, data)
        if not (msg["To"] or msg["Cc"] or msg["Bcc"]):
            raise ValueError("Please add someone to send this to.")
        self._add("Sent", self.address, msg["To"] or "", msg["Subject"], str(data.get("body", "")), datetime.now(timezone.utc), False, False, "", [])

    def contacts(self):
        return [{"address": "jamie.dialup@example.com", "name": "Jamie", "count": 5}, {"address": "mom@example.com", "name": "Mom", "count": 4},
                {"address": "djsparkle@example.com", "name": "DJ Sparkle", "count": 2}, {"address": "pat@example.com", "name": "Pat", "count": 1}]


# --------------------------------------------------------------------------------------
# Web server (localhost only)
# --------------------------------------------------------------------------------------
class App:
    def __init__(self, port):
        self.port = port
        self.token = secrets.token_urlsafe(24)
        self.lock = threading.RLock()
        self.backend = None
        self.auto_demo = False

    def set_backend(self, backend):
        with self.lock:
            if self.backend:
                self.backend.close()
            self.backend = backend


STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2"}
CSP = ("default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
       "frame-src 'self' about: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "DeniseMail"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # never log request lines (they may contain tokens)
            pass

        # -- utilities
        def _host_ok(self):
            host = (self.headers.get("Host") or "").lower()
            return host in ("127.0.0.1:%d" % app.port, "localhost:%d" % app.port)

        def _send(self, status, body, ctype, extra=None):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", CSP)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, status=200):
            self._send(status, json.dumps(obj), "application/json; charset=utf-8")

        def _err(self, msg, status=400):
            self._json({"ok": False, "error": msg}, status)

        def _authed(self, query=None):
            tok = self.headers.get("X-DM-Token") or ((query or {}).get("token") or [""])[0]
            return secrets.compare_digest(tok, app.token)

        def _body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n > MAX_BODY:
                self.close_connection = True
                raise ValueError("That message is too big.")
            raw = self.rfile.read(n) if n else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(data, dict):
                raise ValueError("Bad request.")
            return data

        def _need_backend(self):
            if not app.backend:
                self._err("You are not signed on.", 401)
                return None
            return app.backend

        # -- routing
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            if not self._host_ok():
                return self._err("Bad host.", 403)
            url = urlparse(self.path)
            q = parse_qs(url.query)
            try:
                if url.path.startswith("/api/"):
                    return self._api_get(url.path, q)
                return self._static(url.path)
            except Exception as e:  # keep the server alive; never leak details
                sys.stderr.write("GET error: %s\n" % type(e).__name__)
                return self._err("Something went wrong.", 500)

        def do_POST(self):
            if not self._host_ok():
                return self._err("Bad host.", 403)
            url = urlparse(self.path)
            if not url.path.startswith("/api/") or not self._authed():
                return self._err("Not allowed.", 403)
            try:
                return self._api_post(url.path, self._body())
            except (ValueError, KeyError) as e:
                return self._err(str(e) or "Bad request.")
            except Exception as e:
                sys.stderr.write("POST error: %s\n" % type(e).__name__)
                return self._err("Something went wrong.", 500)

        def _static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            rel = os.path.normpath(path.lstrip("/"))
            full = os.path.realpath(os.path.join(STATIC, rel))
            if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
                return self._send(404, "Not found", "text/plain; charset=utf-8")
            ext = os.path.splitext(full)[1].lower()
            if ext not in STATIC_TYPES:
                return self._send(404, "Not found", "text/plain; charset=utf-8")
            with open(full, "rb") as fh:
                body = fh.read()
            if rel == "index.html":
                body = body.replace(b"__TOKEN__", app.token.encode()).replace(b"__AUTODEMO__", b"1" if app.auto_demo else b"0")
            return self._send(200, body, STATIC_TYPES[ext])

        def _api_get(self, path, q):
            if not self._authed(q):
                return self._err("Not allowed.", 403)
            if path == "/api/status":
                b = app.backend
                return self._json({"ok": True, "signedOn": bool(b), "email": b.address if b else "", "demo": bool(b and b.demo)})
            b = self._need_backend()
            if not b:
                return
            try:
                if path == "/api/folders":
                    return self._json({"ok": True, "folders": b.folders()})
                if path == "/api/messages":
                    folder = (q.get("folder") or ["INBOX"])[0]
                    page = max(0, int((q.get("page") or ["0"])[0]))
                    query = (q.get("q") or [""])[0][:200]
                    items, total = b.list_messages(folder, page, query)
                    return self._json({"ok": True, "messages": items, "total": total, "page": page, "perPage": PER_PAGE})
                if path == "/api/message":
                    return self._json({"ok": True, "message": b.get_message((q.get("folder") or ["INBOX"])[0], int((q.get("uid") or ["0"])[0]))})
                if path == "/api/attachment":
                    name, ctype, data = b.get_attachment((q.get("folder") or ["INBOX"])[0], int((q.get("uid") or ["0"])[0]), int((q.get("index") or ["0"])[0]))
                    # always download, never render, and never trust the declared type
                    return self._send(200, data, "application/octet-stream",
                                      {"Content-Disposition": "attachment; filename*=UTF-8''%s" % quote(name)})
                if path == "/api/poll":
                    return self._json({"ok": True, "unread": b.unread_count()})
                if path == "/api/contacts":
                    return self._json({"ok": True, "contacts": b.contacts()})
            except (ValueError, KeyError) as e:
                return self._err(str(e) or "Bad request.")
            except imaplib.IMAP4.error:
                return self._err("Gmail said no to that request. Try again in a moment.", 502)
            except (OSError, ssl.SSLError):
                return self._err("Could not reach Gmail. Check your internet connection.", 502)
            return self._err("Unknown request.", 404)

        def _api_post(self, path, data):
            if path == "/api/login":
                if data.get("demo"):
                    app.set_backend(DemoBackend())
                    return self._json({"ok": True, "email": app.backend.address, "demo": True})
                address = str(data.get("email", "")).strip()
                password = re.sub(r"\s+", "", str(data.get("password", "")))
                if not EMAIL_RE.match(address) or not password:
                    return self._err("Please enter your Gmail address and your App Password.")
                try:
                    backend = GmailBackend(address, password)
                except imaplib.IMAP4.error:
                    return self._err("Gmail did not accept that sign-on. Use a 16-letter App Password (not your normal password), and make sure 2-Step Verification is on.", 401)
                except (OSError, ssl.SSLError):
                    return self._err("Could not reach Gmail. Check your internet connection.", 502)
                app.set_backend(backend)
                return self._json({"ok": True, "email": address, "demo": False})
            if path == "/api/logout":
                app.set_backend(None)
                return self._json({"ok": True})
            b = self._need_backend()
            if not b:
                return
            try:
                if path == "/api/send":
                    b.send(data)
                    return self._json({"ok": True})
                if path == "/api/flag":
                    flag = str(data.get("flag"))
                    if flag not in ("seen", "starred"):
                        return self._err("Bad request.")
                    b.set_flag(str(data["folder"]), int(data["uid"]), flag, bool(data.get("value")))
                    return self._json({"ok": True})
                if path == "/api/delete":
                    result = b.delete(str(data["folder"]), int(data["uid"]))
                    return self._json({"ok": True, "result": result})
            except smtplib.SMTPAuthenticationError:
                return self._err("Gmail did not accept your App Password for sending.", 401)
            except (smtplib.SMTPException, OSError, ssl.SSLError):
                return self._err("The message could not be sent. Check your connection and try again.", 502)
            except imaplib.IMAP4.error:
                return self._err("Gmail said no to that request. Try again in a moment.", 502)
            return self._err("Unknown request.", 404)

    return Handler


def find_port(start):
    import socket
    for p in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise SystemExit("Could not find a free port.")


class QuietServer(ThreadingHTTPServer):
    """Browsers cancel requests all the time; don't print scary tracebacks for that."""
    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        sys.stderr.write("Server error: %s\n" % type(exc).__name__)


def create_server(port=0, auto_demo=False):
    port = port or find_port(8765)
    app = App(port)
    app.auto_demo = auto_demo
    httpd = QuietServer(("127.0.0.1", port), make_handler(app))
    return httpd, app


def main():
    ap = argparse.ArgumentParser(description="Denise Mail: a retro Gmail program that runs only on your computer.")
    ap.add_argument("--port", type=int, default=0, help="port to use (default: first free one from 8765)")
    ap.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    ap.add_argument("--demo", action="store_true", help="start signed in to the demo mailbox")
    args = ap.parse_args()
    httpd, app = create_server(args.port, args.demo)
    url = "http://127.0.0.1:%d/" % app.port
    print("\n  Denise Mail is running at %s" % url)
    print("  It only works on this computer. Press Ctrl+C here to quit.\n")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Signing off. Bye!")
    finally:
        app.set_backend(None)
        httpd.server_close()


if __name__ == "__main__":
    main()
