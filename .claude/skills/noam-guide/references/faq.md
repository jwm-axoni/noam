# Ready answers to common questions

Each answer is written for a non-technical reader. Reuse the wording; trim to fit.

## What is Noam, in one breath?
A notes app for teams where every note is a plain Markdown file on your own computer, your
teammates can edit the same note with you live, and an AI assistant can read and edit those
notes too. Think "Obsidian, but multiplayer and AI-friendly".

## Is it free?
Yes. The desktop app and the server are open source (Apache 2.0), and Noam is free and
self-hosted only — there is no managed service to pay for. Using it on your own computer is
free forever, and deploying your own server (Docker or Railway) is free with no vault or
member limits.

## Can my team start today?
Yes, today. Deploy your own server (see `docs/DEPLOY.md` for Docker or a one-click Railway
option), sign up in the app, turn on sync, and invite the team. Every vault is unlimited.

## Can I leave a vault someone else owns?
Yes. Open Vault Settings → Vaults, click **Leave** next to the vault and confirm. You lose access
straight away on every device you are signed in on, the vault leaves your switcher, and the folder
on that device goes to the Trash rather than staying behind as a copy. The owner is emailed that
you left (and you get a receipt) when the server sends email. Nobody else's access changes. If you
want back in, ask the owner for a new invitation or join code. The owner of a vault cannot leave
it; they delete it instead. If you only want the vault off one computer but want to stay a member,
use **Remove from device**.

## I forgot my password.
On the sign-in screen choose **Forgot password?**, enter your email, and follow the link we
send (valid for one hour). Setting a new password signs out every other device. If you first
joined with Google, the same link lets you add a password. On a self-hosted server without
email set up, ask the person running it: they can set a new password from the server
(`pnpm run set-password`).

## Do I need an account?
No. You can open a folder and start writing with no account and no internet. An account is only
needed for sync between devices, team collaboration, and the server's MCP AI endpoint.

## Does it work offline?
Yes. Everything local (editing, search, backlinks, graph) works with no connection. When you
reconnect, your changes merge with everyone else's; there are no conflict dialogs.

## What happens if two people edit the same note at once?
Both edits are kept and merged character by character, live, with visible cursors. The same is
true when an AI edits a note while a person is typing in it.

## Where are my notes stored?
In a folder you choose on your disk (default `~/Documents/Noam Vaults/<vault name>`). They are ordinary `.md`
files you can open in any editor, back up, or put in Git. A hidden `.context/` folder inside the
vault holds the search index and sync state; you can delete it and Noam rebuilds it.

## What does the server store? Can Noam read my notes?
The server stores the sync history as binary change records, not `.md` files, and each device
rebuilds its own files from that. Be honest here: the server *can* reconstruct note text; that
is how server-side search, public links and the MCP endpoint work. Notes are not end-to-end
encrypted today (at-rest encryption is on the roadmap). If that matters, self-host.

## Can I use it with my Obsidian vault?
Yes. Open the folder. Markdown, folders, `[[wikilinks]]` and `#tags` carry over. Obsidian
plugins do not. See `file-formats.md` for what happens to non-Markdown files.

## Which platforms?
macOS (Apple Silicon and Intel), Windows 10/11, Linux (AppImage, .deb, .rpm). iOS is planned,
not available. The macOS build is signed and notarized; Windows and Linux builds are unsigned,
so a fresh Windows download shows a SmartScreen warning (More info → Run anyway). The app
updates itself with a signed updater after the first install.

## How do I share notes with my team?
Sign in, turn on sync for your vault, invite people by email or share a join code. New vaults
are shared with the whole team by default; you can make any folder or note private, share it
with specific people, and choose view or edit for each. Roles are owner, admin, member.

## Can I share a note with someone who does not use Noam?
Yes. "Copy link" on a note offers a public link: a read-only web page anyone with the link can
open. Revoke it any time. There is also a private link that only works for teammates with access.

## Does editing the title at the top of a note rename the file?
Yes — that title *is* the file name. Type a new one and press Enter and the file is renamed on
disk; the tab, the sidebar and every list follow. Links to the note keep working, because Noam
tracks notes by an internal id rather than by their path, so a rename never breaks a
`[[wikilink]]` or a backlink. Headings inside the note are ordinary headings and do not rename
anything. If the name is illegal (`/ \ : * ? " < > |`, or starting with a dot) or a neighbouring
note already uses it, you are told inline and nothing is renamed.

## Will Noam rewrite my frontmatter?
Only the exact value you change. Editing a property in the Properties panel replaces those few
characters and nothing else — comments, quoting and key order all stay as you wrote them. And if
your frontmatter uses something Noam's panel does not support (nested structures, multi-line
values, anchors, a repeated key), it does not try: it shows the raw text with a short note, and
leaves the file alone.

## Can I edit the vault folder from outside the app?
Yes, and it is a supported way to work. Create, edit, delete, rename and move `.md` files with any
tool — Finder, a script, an AI agent — and Noam picks the change up and syncs it, merging an
outside edit with whatever a teammate is typing rather than overwriting it. A delete on disk takes
a couple of seconds to reach the team (long enough that an editor's save or a rename is not
mistaken for one) and your copy of the text is kept in the vault's hidden trash folder first. The
one folder to leave alone is the hidden `.context` folder inside the vault: that is Noam's own
index, sync state and trash.

## How does the AI part work?
Two ways. (1) Local: because notes are plain files, any tool on your computer, for example
Claude Code, can edit them directly; Noam notices the change and syncs it. (2) Remote: Noam
has a built-in MCP endpoint (Model Context Protocol, the standard way AI assistants connect to
tools). Create a token in Vault Settings → MCP, give it to your AI client, and the AI can list,
search, read, create, update, move and delete notes, limited by the same permissions as a person.
There is no built-in chat panel or bundled AI model; you bring your own AI.

## Is there version history?
Yes. Each note keeps versions (captured automatically after a pause in editing, and before any
revert) that you can preview and restore. Owners and admins can also take a checkpoint of the
whole vault and revert to it.

## Can I lock a note?
Yes. Lock a note or folder so it becomes read-only for everyone, including admins, until unlocked.

## What is the voice button?
Push-to-talk. Hold it to speak to teammates who are in the same vault. Nothing is recorded or
stored; if someone was offline they simply did not hear it.

## Does it have a graph view, backlinks, tags, search?
Yes to all. Full-text search runs locally and instantly. When a vault is synced there is also a
server-side semantic search. Backlinks survive renames and moves because notes are tracked by a
stable id, not by filename.

## Is there a mobile app or web app?
Not yet. Desktop only; iOS is on the roadmap. Public note links open in any browser, read-only.

## Can I self-host?
Yes — it's the only way to run Noam. The server is Node + Postgres. One-click deploy to
Railway, a Docker Compose bundle, or plain Docker; see `docs/DEPLOY.md`. The app asks for
your server on first run, and you enter your URL there; it is checked before it is saved.
Later you can change it in Account settings → Connection. To save your team the typing,
send them `https://<your-server>/open/connect`: clicking it opens Noam and asks them to
confirm connecting to your server. There are no plan limits.

## What is NOT there (so you do not overpromise)?
Rich WYSIWYG block editing, in-app AI chat, comments and @mentions, end-to-end encryption,
a mobile app, Office file conversion, plugins, two-factor authentication, SSO, audit logs. Several are on the Phase 4 roadmap in
`docs/STATUS.md`; say "planned", never "available".
