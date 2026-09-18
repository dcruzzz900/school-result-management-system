# Updating Your Live Site With This New Version

You already have this app deployed and working on PythonAnywhere. This is a
small update — no schema changes, no new external dependencies.

## What's new in this update

**Multi-school data isolation hardening**, specifically for the offline
layer — this only matters if the same phone/computer is ever used to log
into more than one school's account (e.g. someone who administers two
schools, or a shared device at an IT provider).

- Offline drafts (Score Entry, Roll Call, new students/classes, etc. saved
  while offline) are now kept separate per school on the device. Before
  this update, they were stored in one shared bucket — a different
  school's login on the same device could technically see another
  school's queued drafts sitting in the Offline Queue page, even though
  the server would always still refuse to actually save them under the
  wrong school.
- Cached pages are now wiped the moment a *different* school logs in on a
  device than the one last used there. This matters because a cached page
  is served with zero server contact when offline — so without this, a
  stale page from School A's session could in principle be served if
  School B's account is used on that device later while offline. (The
  offline lock screen already required knowing that specific account's
  password to view a cached page, so this wasn't wide open — this closes
  it properly rather than relying on that.)
- If a device already had drafts queued from before this update, they're
  carried over into whichever school first loads the update on that
  device, rather than silently disappearing.

**Worth knowing:** this hardens *school-to-school* isolation specifically,
since that's what carries real risk (different organizations, potentially
different people entirely). It doesn't add separate cache isolation
between two different staff *at the same school* sharing a device — e.g.
an admin's cached page could still be offline-visible if a regular teacher
uses the same device next, same as before this update. That's a smaller,
same-school concern rather than a cross-school data leak, and isn't
addressed by this phase.

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
   picks up the updated scripts.
9. Test it (needs two schools/accounts to check properly):
   - Log in as School A, queue an offline draft (e.g. add a student while
     in Airplane Mode), then go online and let it sync, or leave it queued.
   - Log out, log in as School B (online) on the *same* browser.
   - Open **Offline Queue** as School B — it should be empty, even if
     School A still has something queued from before it synced.
   - Log back in as School A — their queued item (if any) should still be
     there, untouched.

If anything looks off after reloading, check the **Error log** link on the
Web tab and paste me what it says.





