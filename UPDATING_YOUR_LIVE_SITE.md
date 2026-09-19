# Updating Your Live Site With This New Version

You already have this app deployed and working on PythonAnywhere. This is a
small update — no schema changes, no new external dependencies.

## What's new in this update

**Graceful degradation for online-only features.** This app's only
genuinely online-only actions are the two "email result to parent" buttons
(SMTP has to reach an actual mail server) — there's no payments, AI
features, or cloud backup in this app to degrade, so this phase is scoped
to what actually exists.

- **Email to Parent** (on a student's Result page) and **Email All Results
  to Parents** (on a class's Broadsheet page) now queue automatically if
  you click them while offline, instead of failing with a browser network
  error. They'll actually send once you're back online — same Offline
  Queue mechanism as everything else, with wording that says "queued to
  send" rather than "will sync", since that's a clearer way to describe
  what's actually about to happen.
- Both are now protected against sending twice: if a send actually goes
  through on the server but your device never sees the confirmation
  (connection drops right after), retrying it recognizes the repeat and
  skips resending rather than emailing the parent a duplicate. I tested
  this directly — simulating "this already sent" and confirming a retry
  returns the same success message without attempting to send again.
- Every offline-queued action (not just these two) now carries a one-time
  token for the same reason, so this same protection is available to any
  future online-only or side-effecting action added later, not just email.

## This completes the offline-first requirements

With this phase, everything originally asked for has been built and
tested: offline login with encrypted local credentials and role/expiry
handling, full offline data entry including brand-new records created
offline, offline scores/attendance/subject-assignment for those new
records, offline result viewing with a live preview of unsynced changes,
multi-school data isolation on the device, and now graceful handling of
the app's one online-only feature (email).

**Worth keeping in mind going forward:** this was all built and tested in
a local sandbox, not against your live PythonAnywhere deployment or a real
phone. Test each piece for real on an actual device before relying on it
for daily use — especially the offline login and multi-school isolation
pieces, since those touch how staff actually access the app.

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
9. Test it:
   - Turn on Airplane Mode.
   - Open a student's Result page and click **Email to Parent** — you
     should see a "Queued: ... It'll be sent once you're back online"
     toast instead of a network error.
   - Turn Airplane Mode back off, open **Offline Queue**, tap **Sync
     Now** — it should show as sent (check your school's email settings
     are configured under Setup → Email Settings for the actual send to
     succeed, same as it always required).

If anything looks off after reloading, check the **Error log** link on the
Web tab and paste me what it says.






