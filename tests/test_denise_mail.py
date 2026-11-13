"""
Tests for Denise Mail. Run:  python3 -m unittest discover -s tests -v

The Gmail tests use a FAKE IMAP/SMTP server that returns responses in the same shape
Python's imaplib gives for real Gmail. No real account or network is used.
"""
import http.client
import imaplib
import json
import os
import re
import sys
import threading
import unittest
import urllib.error
import urllib.request
from email.message import EmailMessage

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import denise_mail as dm  # noqa: E402


def make_raw(subject, frm="Ann <ann@example.com>", to="me@gmail.com", body="Hello there", html=None, attach=None, date="Mon, 03 Nov 2025 10:00:00 +0000"):
    m = EmailMessage()
    m["From"], m["To"], m["Subject"], m["Date"] = frm, to, subject, date
    m.set_content(body)
    if html:
        m.add_alternative(html, subtype="html")
    for name, data in (attach or []):
        m.add_attachment(data, maintype="application", subtype="octet-stream", filename=name)
    return m.as_bytes()


class FakeIMAP:
    """Just enough of imaplib.IMAP4_SSL, with Gmail-shaped responses."""

    def __init__(self):
        self.calls = []
        self.fail_next = False
        self.boxes = {
            "INBOX": {1: (make_raw("First"), ["\\Seen"]), 2: (make_raw("=?utf-8?B?SGVsbG8g8J+RiyB3b3JsZA==?=", frm="=?utf-8?Q?J=C3=BCrgen?= <j@example.com>"), []),
                      3: (make_raw("With file", html="<p>Hi <b>there</b></p>", attach=[("note.txt", b"abc")]), [])},
            "[Gmail]/Sent Mail": {7: (make_raw("Sent one", frm="me@gmail.com", to="bob@example.com"), ["\\Seen"])},
            "[Gmail]/Trash": {9: (make_raw("Old"), ["\\Seen"])},
        }
        self.selected = None

    def login(self, user, pw):
        self.calls.append(("login", user))
        return "OK", [b"ok"]

    def logout(self):
        self.calls.append(("logout",))

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
                      b'(\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"', b'(\\Noselect \\HasChildren) "/" "[Gmail]"',
                      b'(\\HasNoChildren) "/" "Work Stuff"', b'(\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"']

    def status(self, folder, items):
        name = folder.strip('"')
        unseen = sum(1 for _, (r, f) in self.boxes.get(name, {}).items() if "\\Seen" not in f)
        return "OK", [('%s (UNSEEN %d)' % (folder, unseen)).encode()]

    def select(self, folder, readonly=False):
        name = folder.strip('"')
        if name not in self.boxes:
            return "NO", [b"nope"]
        self.selected = name
        self.calls.append(("select", name, readonly))
        return "OK", [str(len(self.boxes[name])).encode()]

    def expunge(self):
        self.calls.append(("expunge", self.selected))
        box = self.boxes[self.selected]
        for uid in [u for u, (r, f) in box.items() if "\\Deleted" in f]:
            del box[uid]
        return "OK", [b"ok"]

    def uid(self, cmd, *args):
        if self.fail_next:
            self.fail_next = False
            raise imaplib.IMAP4.abort("socket error: EOF")
        box = self.boxes[self.selected]
        self.calls.append(("uid", cmd) + tuple(args))
        if cmd == "SEARCH":
            uids = sorted(box)
            if "X-GM-RAW" in args:
                needle = args[args.index("X-GM-RAW") + 1].strip('"').lower().replace('\\"', '"')
                uids = [u for u in uids if needle in box[u][0].decode("utf-8", "replace").lower()]
            return "OK", [" ".join(str(u) for u in uids).encode()]
        if cmd == "FETCH":
            ids = [int(x) for x in args[0].split(",")]
            out = []
            for uid in ids:
                raw, flags = box[uid]
                f = "(%s)" % " ".join(flags)
                if "HEADER.FIELDS" in args[1]:
                    head = raw.split(b"\r\n\r\n", 1)[0] + b"\r\n\r\n"
                    out.append((("%d (UID %d FLAGS %s RFC822.SIZE %d BODY[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE)] {%d}" % (uid, uid, f, len(raw), len(head))).encode(), head))
                    out.append(b")")
                else:
                    out.append((("%d (UID %d FLAGS %s BODY[] {%d}" % (uid, uid, f, len(raw))).encode(), raw))
                    out.append(b")")
            return "OK", out
        if cmd == "STORE":
            uid = int(args[0])
            flag = args[2].strip("()")
            flags = box[uid][1]
            if args[1] == "+FLAGS" and flag not in flags:
                flags.append(flag)
            if args[1] == "-FLAGS" and flag in flags:
                flags.remove(flag)
            return "OK", [b"ok"]
        if cmd == "COPY":
            uid = int(args[0])
            dest = args[1].strip('"')
            self.boxes[dest][uid + 1000] = (box[uid][0], list(box[uid][1]))
            return "OK", [b"ok"]
        return "BAD", [b"unknown"]


class FakeSMTP:
    sent = []
    logged = []

    def login(self, u, p):
        FakeSMTP.logged.append(u)

    def send_message(self, msg):
        FakeSMTP.sent.append(msg)

    def quit(self):
        pass


def new_backend():
    fake = FakeIMAP()
    b = dm.GmailBackend("me@gmail.com", "abcd efgh", imap_factory=lambda: fake, smtp_factory=FakeSMTP)
    return b, fake


class GmailBackendTests(unittest.TestCase):
    def test_folders_kinds_and_order(self):
        b, _ = new_backend()
        f = b.folders()
        self.assertEqual([x["kind"] for x in f][:4], ["inbox", "sent", "spam", "trash"])
        self.assertEqual([x["label"] for x in f][:4], ["Inbox", "Sent Mail", "Junk Mail", "Trash"])
        self.assertIn("Work Stuff", [x["id"] for x in f])
        self.assertNotIn("[Gmail]", [x["id"] for x in f])
        self.assertEqual(f[0]["unread"], 2)

    def test_list_messages_newest_first_and_parsing(self):
        b, _ = new_backend()
        items, total = b.list_messages("INBOX")
        self.assertEqual(total, 3)
        self.assertEqual([i["uid"] for i in items], [3, 2, 1])
        by = {i["uid"]: i for i in items}
        self.assertFalse(by[1]["unread"])
        self.assertTrue(by[2]["unread"])
        self.assertEqual(by[2]["subject"], "Hello \U0001F44B world")
        self.assertEqual(by[2]["fromName"], "Jürgen")
        self.assertTrue(by[3]["attachment"])
        self.assertFalse(by[1]["attachment"])
        self.assertEqual(by[1]["date"], "2025-11-03T10:00:00Z")

    def test_listing_does_not_change_flags(self):
        b, fake = new_backend()
        b.list_messages("INBOX")
        self.assertEqual(fake.boxes["INBOX"][2][1], [])
        self.assertTrue(all(c[2] is True for c in fake.calls if c[0] == "select"))

    def test_get_message_text_html_attachments_and_marks_seen(self):
        b, fake = new_backend()
        m = b.get_message("INBOX", 3)
        self.assertIn("Hello there", m["text"])
        self.assertIn("<b>there</b>", m["html"])
        self.assertEqual([a["filename"] for a in m["attachments"]], ["note.txt"])
        self.assertEqual(m["attachments"][0]["size"], 3)
        self.assertIn("\\Seen", fake.boxes["INBOX"][3][1])

    def test_get_message_already_seen_does_not_store(self):
        b, fake = new_backend()
        b.get_message("INBOX", 1)
        self.assertFalse([c for c in fake.calls if c[:2] == ("uid", "STORE")])

    def test_attachment_download(self):
        b, _ = new_backend()
        name, ctype, data = b.get_attachment("INBOX", 3, 0)
        self.assertEqual((name, data), ("note.txt", b"abc"))
        with self.assertRaises(KeyError):
            b.get_attachment("INBOX", 3, 5)

    def test_set_flag(self):
        b, fake = new_backend()
        b.set_flag("INBOX", 1, "seen", False)
        self.assertNotIn("\\Seen", fake.boxes["INBOX"][1][1])
        b.set_flag("INBOX", 2, "starred", True)
        self.assertIn("\\Flagged", fake.boxes["INBOX"][2][1])

    def test_delete_moves_to_trash(self):
        b, fake = new_backend()
        msg = b.delete("INBOX", 1)
        self.assertEqual(msg, "moved to the Trash")
        self.assertNotIn(1, fake.boxes["INBOX"])
        self.assertTrue(any(subj for subj in fake.boxes["[Gmail]/Trash"] if subj != 9))
        self.assertIn(("uid", "COPY", "1", '"[Gmail]/Trash"'), fake.calls)

    def test_delete_in_trash_is_permanent(self):
        b, fake = new_backend()
        msg = b.delete("[Gmail]/Trash", 9)
        self.assertEqual(msg, "deleted forever")
        self.assertNotIn(9, fake.boxes["[Gmail]/Trash"])
        self.assertFalse([c for c in fake.calls if c[:2] == ("uid", "COPY")])

    def test_search_uses_gmail_raw_and_quotes(self):
        b, fake = new_backend()
        items, total = b.list_messages("INBOX", 0, 'with "file"')
        self.assertTrue(any(c[:4] == ("uid", "SEARCH", None, "X-GM-RAW") for c in fake.calls))
        self.assertIn('"with \\"file\\""', [c[4] for c in fake.calls if len(c) > 4 and c[3:4] == ("X-GM-RAW",)])
        items, total = b.list_messages("INBOX", 0, "first")
        self.assertEqual([i["uid"] for i in items], [1])

    def test_reconnects_once_when_connection_drops(self):
        b, fake = new_backend()
        fake.fail_next = True
        items, total = b.list_messages("INBOX")
        self.assertEqual(total, 3)
        self.assertGreaterEqual(len([c for c in fake.calls if c[0] == "login"]), 2)

    def test_unread_and_contacts(self):
        b, _ = new_backend()
        self.assertEqual(b.unread_count(), 2)
        b.list_messages("INBOX")
        addrs = [c["address"] for c in b.contacts()]
        self.assertIn("ann@example.com", addrs)
        self.assertNotIn("me@gmail.com", addrs)

    def test_send_builds_message(self):
        FakeSMTP.sent.clear()
        b, _ = new_backend()
        b.send({"to": "bob@example.com", "cc": "c@example.com", "subject": "Hi\r\nBcc: evil@example.com", "body": "Yo", "inReplyTo": "<x@y>"})
        msg = FakeSMTP.sent[0]
        self.assertEqual(msg["From"], "me@gmail.com")
        self.assertEqual(msg["To"], "bob@example.com")
        self.assertNotIn("evil@example.com", str(msg["Bcc"]))
        self.assertEqual(msg["In-Reply-To"], "<x@y>")
        self.assertEqual(msg.get_content().strip(), "Yo")

    def test_send_requires_recipient(self):
        b, _ = new_backend()
        with self.assertRaises(ValueError):
            b.send({"to": "", "subject": "x", "body": "y"})

    def test_password_forgotten_on_close(self):
        b, _ = new_backend()
        b.close()
        self.assertIsNone(b._password)


class DemoBackendTests(unittest.TestCase):
    def test_demo_flow(self):
        d = dm.DemoBackend()
        items, total = d.list_messages("INBOX")
        self.assertGreaterEqual(total, 8)
        first = items[0]
        m = d.get_message("INBOX", first["uid"])
        self.assertTrue(m["text"])
        self.assertTrue(m["html"])
        d.send({"to": "a@b.co", "subject": "Hello", "body": "Hi"})
        self.assertEqual(d.list_messages("Sent")[0][0]["subject"], "Hello")
        self.assertIn("Trash", d.delete("INBOX", first["uid"]))
        self.assertEqual(d.list_messages("Trash")[1], 1)
        self.assertIn("forever", d.delete("Trash", first["uid"]))
        self.assertEqual(d.list_messages("Trash")[1], 0)

    def test_demo_attachment_and_star(self):
        d = dm.DemoBackend()
        items, _ = d.list_messages("INBOX", 0, "track list")
        uid = items[0]["uid"]
        name, _, data = d.get_attachment("INBOX", uid, 0)
        self.assertEqual(name, "mixtape-tracklist.txt")
        self.assertIn(b"Dancing Queen", data)
        d.set_flag("INBOX", uid, "starred", True)
        self.assertTrue(any(i["uid"] == uid for i in d.list_messages("Starred")[0]))


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd, cls.app = dm.create_server(port=0)
        cls.port = cls.app.port
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def req(self, method, path, body=None, token=True, host=None, raw=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Host": host or "127.0.0.1:%d" % self.port}
        if token:
            headers["X-DM-Token"] = self.app.token
        data = None
        if body is not None:
            data = json.dumps(body)
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        payload = r.read()
        conn.close()
        return r.status, dict(r.getheaders()), (payload if raw else (json.loads(payload) if payload[:1] in (b"{", b"[") else payload))

    def test_00_index_has_token_and_security_headers(self):
        status, headers, body = self.req("GET", "/", token=False, raw=True)
        self.assertEqual(status, 200)
        self.assertIn(self.app.token.encode(), body)
        self.assertNotIn(b"__TOKEN__", body)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Frame-Options"], "DENY")

    def test_01_api_requires_token(self):
        self.assertEqual(self.req("GET", "/api/status", token=False)[0], 403)
        self.assertEqual(self.req("POST", "/api/login", {"demo": True}, token=False)[0], 403)

    def test_02_wrong_host_rejected(self):
        self.assertEqual(self.req("GET", "/api/status", host="evil.example.com")[0], 403)
        self.assertEqual(self.req("GET", "/", host="evil.example.com:%d" % self.port, token=False)[0], 403)

    def test_03_path_traversal_blocked(self):
        for p in ("/../denise_mail.py", "/%2e%2e/denise_mail.py", "/css/../../denise_mail.py", "/..%2fdenise_mail.py"):
            status, _, _ = self.req("GET", p, token=False, raw=True)
            self.assertEqual(status, 404, p)

    def test_04_not_signed_on(self):
        self.assertEqual(self.req("POST", "/api/logout", {})[0], 200)
        self.assertEqual(self.req("GET", "/api/folders")[0], 401)
        self.assertFalse(self.req("GET", "/api/status")[2]["signedOn"])

    def test_05_login_validation(self):
        self.assertEqual(self.req("POST", "/api/login", {"email": "nope", "password": "x"})[0], 400)
        self.assertEqual(self.req("POST", "/api/login", {"email": "a@b.co", "password": ""})[0], 400)

    def test_06_demo_session_end_to_end(self):
        self.assertTrue(self.req("POST", "/api/login", {"demo": True})[2]["ok"])
        st = self.req("GET", "/api/status")[2]
        self.assertTrue(st["signedOn"] and st["demo"])
        folders = self.req("GET", "/api/folders")[2]["folders"]
        self.assertEqual(folders[0]["id"], "INBOX")
        msgs = self.req("GET", "/api/messages?folder=INBOX&page=0")[2]
        self.assertGreater(msgs["total"], 5)
        uid = msgs["messages"][0]["uid"]
        full = self.req("GET", "/api/message?folder=INBOX&uid=%d" % uid)[2]["message"]
        self.assertTrue(full["subject"])
        self.assertEqual(self.req("POST", "/api/flag", {"folder": "INBOX", "uid": uid, "flag": "starred", "value": True})[0], 200)
        self.assertEqual(self.req("POST", "/api/flag", {"folder": "INBOX", "uid": uid, "flag": "evil", "value": True})[0], 400)
        self.assertEqual(self.req("POST", "/api/send", {"to": "x@y.co", "subject": "Hi", "body": "Hi"})[0], 200)
        self.assertEqual(self.req("POST", "/api/send", {"to": "", "subject": "Hi", "body": "Hi"})[0], 400)
        self.assertIn("Trash", self.req("POST", "/api/delete", {"folder": "INBOX", "uid": uid})[2]["result"])
        self.assertGreaterEqual(len(self.req("GET", "/api/contacts")[2]["contacts"]), 1)
        self.assertIn("unread", self.req("GET", "/api/poll")[2])

    def test_07_attachment_is_forced_download(self):
        self.req("POST", "/api/login", {"demo": True})
        msgs = self.req("GET", "/api/messages?folder=INBOX&q=track")[2]["messages"]
        uid = msgs[0]["uid"]
        status, headers, body = self.req("GET", "/api/attachment?folder=INBOX&uid=%d&index=0" % uid, raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertIn("attachment;", headers["Content-Disposition"])
        self.assertIn(b"Dancing Queen", body)

    def test_08_attachment_token_in_query_only_for_get(self):
        self.req("POST", "/api/login", {"demo": True})
        uid = self.req("GET", "/api/messages?folder=INBOX&q=track")[2]["messages"][0]["uid"]
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request("GET", "/api/attachment?folder=INBOX&uid=%d&index=0&token=%s" % (uid, self.app.token), headers={"Host": "127.0.0.1:%d" % self.port})
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()

    def test_09_oversized_body_rejected(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.putrequest("POST", "/api/send", skip_host=True)
        conn.putheader("Host", "127.0.0.1:%d" % self.port)
        conn.putheader("X-DM-Token", self.app.token)
        conn.putheader("Content-Length", str(10 * 1024 * 1024))
        conn.endheaders()
        r = conn.getresponse()
        self.assertEqual(r.status, 400)
        conn.close()

    def test_10_failed_login_does_not_echo_password_or_touch_network(self):
        from unittest import mock
        self.req("POST", "/api/logout", {})
        with mock.patch.object(dm, "GmailBackend", side_effect=imaplib.IMAP4.error("LOGIN failed")):
            status, _, body = self.req("POST", "/api/login", {"email": "someone@example.com", "password": "supersecretpassword1"})
        self.assertEqual(status, 401)
        self.assertNotIn("supersecretpassword1", json.dumps(body))
        self.assertIn("App Password", body["error"])
        with mock.patch.object(dm, "GmailBackend", side_effect=OSError("no network")):
            status, _, body = self.req("POST", "/api/login", {"email": "someone@example.com", "password": "abcdabcdabcdabcd"})
        self.assertEqual(status, 502)
        self.assertFalse(self.app.backend)  # a failed login must not leave a session behind


if __name__ == "__main__":
    unittest.main()
