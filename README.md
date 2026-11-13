# Poppy Mail 📬

A retro email program for your **Gmail**, with three looks:

- **MSN-style ("Messenger Blue")**: glossy blue, a folder list on the left, your messages on top, and a preview pane below.
- **AOL-style ("Dial-Up Online")**: a chunky yellow toolbar and gray beveled windows on a blue desktop. Windows you can drag around, a Welcome window, a Buddy List, and a mailbox with tabs.
- **MySpace-style ("Glitter Profile")**: a girly, decorated profile page in hot pink and purple with a sparkly background. You get a **profile card** (avatar, glitter name, "Online now", mood, a "Now playing" song with a little tune button, and an "About me"), a **Top 8** of the people you write to most, a "Mail Space" banner, and four color schemes (Bubblegum, Grape, Black & pink, Aqua). Press **My profile** to edit everything, and **Sparkles** for an optional sparkle cursor trail. Your profile is saved only in this browser on this computer.

It also has a dial-up sign-on with modem sounds, a "you've got new mail" chime, a little mailbox flag, an "Online 00:03:21" clock, and a **demo mailbox** so you can play before connecting a real account. All the sounds are made in your browser, and all the artwork is original (emoji and CSS). This is a fun tribute to the early web and is not affiliated with, or endorsed by, any real company.

## Start it

**Easiest:** double-click **`Start Poppy Mail.command`**. A Terminal window opens and your browser goes to the program.

**Or in Terminal:**

```bash
cd "/path/to/denise-mail"
python3 denise_mail.py
```

Add `--demo` to start straight in the demo mailbox. Press `Ctrl+C` in Terminal to quit.

There is nothing to install: it only uses Python 3 (already on most Macs) and your web browser.

## Connect your Gmail

Gmail needs a special **App Password** for programs like this (your normal password won't work, and you should never type it into a program like this).

1. Turn on **2-Step Verification** for your Google account (Google Account, then Security).
2. Go to **myaccount.google.com/apppasswords** and create an App Password named "Poppy Mail".
3. Copy the 16-letter code and paste it into the **App Password** box on the sign-on screen (spaces don't matter).

Work and school accounts often don't allow App Passwords. If yours doesn't, ask your admin, or use the demo.

## What you can do

Read mail (plain text, or formatted with pictures blocked), reply, reply all, forward, write new mail, star, mark unread, search (Gmail searches like `from:mom` work), move to the Trash, download attachments, and see the people you write to most. Use the **Look** menu to switch looks any time. Keyboard: arrow keys move through the list, Enter opens a message (AOL-style), and Delete moves a message to the Trash.

## Privacy and safety (please read)

- **Everything stays on your computer.** The program runs a tiny server on `127.0.0.1` (your own computer only). It talks directly to Gmail. Nothing is sent to anyone else, and there are no analytics or third-party requests.
- **Your App Password is kept in memory only.** It is never saved to disk, never logged, and is forgotten when you sign off or quit. You type it each time you sign on. (You can revoke it any time at myaccount.google.com/apppasswords.)
- **The local server is locked down:** it rejects requests that don't come from its own page (a secret token that changes every time you start it), rejects unexpected host names, serves only its own files, and sends strict security headers.
- **Emails can't spy on you:** formatted emails are shown in a sandbox that can't run scripts, and **pictures from the internet are blocked** until you click "Show pictures" (that's how tracking pixels work). Links open in a new tab. Attachments are always downloaded, never opened inside the program.
- **Deleting is gentle:** Delete moves a message to the Trash (you can get it back). Only deleting from inside the Trash is permanent, and it asks first.

## Things to know

- Forwarding doesn't include attachments, and you can't attach files to new messages yet.
- Messages are shown 40 at a time (use the arrows). Gmail labels appear as extra folders.
- Sent mail is saved in your Gmail "Sent Mail" automatically, like any Gmail program.
- I built and tested this with a fake Gmail server and the demo mailbox, **not with a real account**, so please try it with yours and tell me if anything looks off.

## For tinkerers

- `denise_mail.py`: the whole back end (Gmail IMAP and SMTP, demo mailbox, local web server).
- `static/`: the interface (`index.html`, `css/retro.css` with both looks, `js/app.js`, `js/wm.js` for draggable windows, `js/sound.js` for sounds).
- Run the tests: `python3 -m unittest discover -s tests -v`
