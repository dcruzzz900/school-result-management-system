# Updating Your Live Site With This New Version

You already have this app deployed and working on PythonAnywhere. This is a
small update — no schema changes this time, no new external dependencies.

## What's new in this update

**Offline data entry now covers scores, attendance, and subject
assignments for students/classes/subjects created offline** — not just the
records themselves.

- Add a student offline, then go straight to **Score Entry** or **Roll
  Call** for that student's class (still offline) — the student now shows
  up in the table, marked "(pending sync)", ready for scores or attendance.
- Assigning a subject to a class (**Setup → Assign Subjects**) now also
  works with classes, subjects, or teachers that were themselves just
  created offline and haven't synced yet — they show up in the dropdowns
  as "(pending sync)" too.
- When everything syncs, it happens in the right order automatically: the
  student (or class, subject, teacher) syncs first and gets a real ID from
  the server, and every score/attendance/assignment entry that referenced
  it is updated to that real ID before being sent.
- If you enter scores for a mix of already-existing students and a
  brand-new offline one in the same Score Entry save, the whole save waits
  until that new student has synced, then sends everyone together — this
  keeps things simple and safe, at the cost of the existing students'
  scores waiting slightly longer too when a new student's in the mix.

**Known limitation:** if a class has *zero* existing students, Roll Call
currently shows "No active students in this class yet" and won't display
even a pending offline-created student there — this only affects a class
that has no students at all yet. Works normally for Score Entry regardless
of how many existing students there are.

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
   - Add a new student to an existing class (**Setup → Students**).
   - Go to **Score Entry** for that class/a subject — the new student
     should appear, marked "(pending sync)". Enter a score for them.
   - Turn Airplane Mode back off, open **Offline Queue**, tap **Sync Now**.
     Both the student and their score should sync — check the score landed
     on the right student.
   - Try the same for **Roll Call**, and for assigning a subject to a
     newly-created (still offline) class in **Setup → Assign Subjects**.

If anything looks off after reloading, check the **Error log** link on the
Web tab and paste me what it says.



