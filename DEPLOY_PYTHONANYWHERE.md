# Deploying to PythonAnywhere (Free, Step-by-Step)

This hosts your app at a free web address like `yourschool.pythonanywhere.com`
that teachers can reach from anywhere — home, phone, another school building.
Unlike most free hosting, PythonAnywhere's free tier stays online all the
time (it doesn't "fall asleep" between visits).

Budget: **$0**. Technical skill needed: **none beyond copy-pasting commands
exactly as shown.** This takes about 20-30 minutes the first time.

---

## Step 1 — Create your PythonAnywhere account

1. Go to **https://www.pythonanywhere.com**
2. Click **Pricing & signup**, then choose the **"Create a Beginner account"** (free) option.
3. Pick a username — this becomes part of your web address
   (e.g. username `greenwoodschool` → site is `greenwoodschool.pythonanywhere.com`).
   Choose something recognizable to your school.
4. Confirm your email if asked.

---

## Step 2 — Upload the app

1. Once logged in, click the **Files** tab (top menu).
2. You'll see your home directory. Click **Upload a file**, and upload the
   `school-result-system.zip` file I gave you.
3. Click the **Consoles** tab, then start a **Bash** console (click "Bash").
   A black terminal screen opens — this is normal, just follow the commands below.
4. In that console, type this and press Enter to unzip the app:
   ```
   unzip school-result-system.zip
   ```
5. Then move into the folder:
   ```
   cd school-results
   ```
   Leave this console tab open — you'll come back to it.

---

## Step 3 — Set up the Python environment

Still in the same Bash console, run these commands **one at a time**,
pressing Enter after each and waiting for it to finish:

```
mkvirtualenv --python=/usr/bin/python3.10 schoolenv
```

(If it says that command isn't found, use `python3.10 -m venv schoolenv` then
`source schoolenv/bin/activate` instead — either way, continue below once
your prompt shows `(schoolenv)` at the start of the line.)

```
pip install -r requirements.txt
```

This installs Flask, ReportLab, and the other pieces the app needs. Wait for
it to finish — you'll see your cursor return to a normal prompt.

---

## Step 4 — Create the Web App

1. Click the **Web** tab (top menu).
2. Click **Add a new web app**.
3. Click **Next**, then choose **Manual configuration** (NOT the "Flask" quick option — this matters).
4. Choose **Python 3.10**, then **Next**. It creates a basic web app.

---

## Step 5 — Point it at your code

Still on the **Web** tab, you'll now see a configuration page for your new
web app. Update these sections:

**Code section:**
- **Source code:** set to `/home/yourusername/school-results` (replace `yourusername` with your actual PythonAnywhere username)
- **Working directory:** same path: `/home/yourusername/school-results`

**Virtualenv section:**
- Enter: `/home/yourusername/.virtualenvs/schoolenv`

**WSGI configuration file:** click the link shown (something like
`/var/www/yourusername_pythonanywhere_com_wsgi.py`) to edit it. **Delete
everything in that file** and replace it with:

```python
import sys

path = '/home/yourusername/school-results'
if path not in sys.path:
    sys.path.append(path)

from app import app as application
```

Replace `yourusername` with your actual username in that path. Click **Save**.

**Static files section** (scroll down), click **Enter URL** and **Enter path**, add one row:
- URL: `/static/`
- Directory: `/home/yourusername/school-results/static/`

---

## Step 6 — Launch it

1. Scroll to the top of the **Web** tab and click the big green **Reload** button.
2. Click your web app's address at the top of the page (e.g.
   `yourusername.pythonanywhere.com`) to open it.
3. You should see the login page. Log in with:
   - Username: `admin`
   - Password: `admin123`

**Immediately go to Setup → Teachers and change the admin password situation**
by creating real accounts for your staff — the demo admin/teacher logins
should not stay active once real people are using this. (A dedicated
"change password" screen isn't built yet — for now, the safest option is to
delete the demo accounts directly via a Bash console using Python, or ask me
to add a proper account-management screen before you go live.)

---

## Making changes later

Any time you edit the code and need to re-upload:
1. Upload the new files via the **Files** tab (or edit them directly in
   PythonAnywhere's file editor).
2. Go to the **Web** tab and click **Reload** again — that's it.

Your database (`instance/school.db`) stays untouched across reloads, so your
students, scores, and results are safe when you update the code.

## Backing up your data

Your school's data lives in one file: `school-results/instance/school.db`.
Download this file periodically via the **Files** tab as a backup — right-click
it and choose Download (or open it and use the download icon).

---

## If something goes wrong

- Check the **Error log** link on the **Web** tab — it shows the exact
  Python error if the site won't load.
- Make sure every `yourusername` placeholder above was replaced with your
  actual PythonAnywhere username.
- Come back to this conversation and paste me the error log content — I can
  help debug it.
