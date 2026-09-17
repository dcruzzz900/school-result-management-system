# Updating Your Live Site With This New Version

You already have this app deployed and working on PythonAnywhere. This is a
small update — no schema changes, no new files. It upgrades your live
database in place with **zero data loss**.

## What's new in this update

Fully wires up offline data entry so staff can keep working with no
connection and have it sync automatically once they're back online.

- **Pages now open while fully offline.** Previously, only form
  *submissions* were queued while offline — but if you opened Score Entry,
  Roll Call, or any admin form fresh with zero connectivity, you'd just see
  a "please reconnect" message instead of the form. Now, any page that's
  been opened once while online is cached and can be reopened offline after
  that, with the data as it was at last load.
- **Logins now last 30 days** instead of ending whenever the browser or
  app is closed. This matters for offline use — without it, a teacher who's
  offline for a stretch (weekend, poor signal for a few days) could get
  logged out, and their queued offline entries would fail to sync silently
  once back online, with no login screen to tell them why.
- No changes to the offline queue itself (Score Entry, Roll Call, Update
  Comments/Attendance, and the admin add/edit forms) — that queuing and
  auto-sync was already working; this update makes sure the pages behind it
  are actually reachable offline too.

**One inherent limit worth knowing:** a page has to be opened at least once
while online before it can be opened offline. There's no way around this —
the device has to receive the page from the server before it can show it
without one. So the recommended habit for staff: open your Score Entry and
Roll Call pages for your usual classes once while you still have signal
(e.g. at the start of the term), and they'll stay available offline from
then on.

## Steps

1. Log in to **pythonanywhere.com** and go to the **Files** tab.
2. Upload this new `school-result-system.zip` to your home directory.
3. Go to the **Consoles** tab, open a **Bash** console.
4. Unzip it to a temporary folder:
   ```
   unzip -o school-result-system.zip -d new_version
   ```
5. Copy over the code files (skips `instance/`, so your database is untouched):
   ```
   cp new_version/school-results/app.py school-results/app.py
   cp new_version/school-results/db.py school-results/db.py
   cp new_version/school-results/pdf_utils.py school-results/pdf_utils.py
   cp new_version/school-results/email_utils.py school-results/email_utils.py
   cp new_version/school-results/create_super_admin.py school-results/create_super_admin.py
   cp new_version/school-results/reports.py school-results/reports.py
   cp new_version/school-results/schema.sql school-results/schema.sql
   cp new_version/school-results/requirements.txt school-results/requirements.txt
   cp -r new_version/school-results/templates/. school-results/templates/
   cp -r new_version/school-results/static/. school-results/static/
   ```
6. Reinstall dependencies (safe either way, no new packages this time):
   ```
   workon schoolenv
   cd school-results
   pip install -r requirements.txt
   ```
7. Go to the **Web** tab and click the big green **Reload** button.
8. On a phone that already has this app installed/bookmarked, do a full
   refresh once (pull-to-refresh or close and reopen the tab/app) so it
   picks up the new service worker — it auto-updates in the background
   otherwise, just not instantly.
9. While still online, open Score Entry and Roll Call for each class staff
   will need, so those pages get cached for offline use.
10. Test it: turn on Airplane Mode, open a previously-visited Score Entry
    or Roll Call page, make an entry, and save. You should see a "Saved
    offline" toast. Turn Airplane Mode back off and either wait a moment or
    visit **Offline Queue** (in Settings) and tap **Sync Now** — the entry
    should disappear from the queue once it's synced.

If anything looks off after reloading, check the **Error log** link on the
Web tab and paste me what it says.
