# Updating Your Live Site With This New Version

You already have this app deployed and working on PythonAnywhere. This is a
small update — no schema changes, no new files. It upgrades your live
database in place with **zero data loss**.

## What's new in this update

- **"Clear Demo Data" is back** as a lighter option alongside "Delete
  Account" in **Settings**. It wipes just the sample classes, subjects,
  students, and teachers so you can load your real school's data on a clean
  slate — your login, sessions/terms, grading setup, and skill traits are
  all kept. This is different from Delete Account, which permanently
  removes your *entire* school.
- Fixed a small gap: clearing demo data now also cleans up the academic
  history (enrollment) records tied to the removed students, which was
  missed when that table was added in a recent update.
- This action is now recorded in the audit log, same as other account-level
  changes.

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
8. Open your site, log in, and check **Settings** for the restored "Clear
   Demo Data" option.

If anything looks off after reloading, check the **Error log** link on the
Web tab and paste me what it says.
