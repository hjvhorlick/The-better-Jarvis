# Installing and starting JARVIS

JARVIS runs on your own computer and you use it in a web browser. There is no installer
program (no `.exe` or `.dmg`). Instead, a starter file sets everything up the first time
and starts the app after that.

## What you need

- **Python 3.10, 3.11 or 3.12.** Newer versions (3.13 and up) are not supported yet, because
  the camera package (My Hands) does not have builds for them. Get Python from python.org.
- **A Gemini API key** from Google, for the chat's online answers. Put it in
  `config/api_keys.json` as `"gemini_api_key"`, or set the `GEMINI_API_KEY` environment
  variable. The file stays on this computer. Do not share it.
- **About 2 GB of free disk space** for the packages (they took 1.5 GB in the build environment).
  The speech models download later and add more.
- **Internet** for the first install. Later starts work offline: local commands, saved
  answers and this computer's voice keep working. Fresh answers from Gemini, the Live
  voice session and transcription do not — they are online features.

## Windows

1. Install Python from python.org. On the first screen tick **"Add python.exe to PATH"**.
2. Open the project folder and **double-click `Start JARVIS.bat`**.
3. The first run takes several minutes while it installs the packages. Later runs are quick.
4. Your browser opens at `http://127.0.0.1:8765`. Keep the black window open while you use JARVIS.
   Press Ctrl+C in that window to stop it.

Windows may ask about the firewall the first time. Choose **Private networks only**
(see "Firewall" below).

## macOS

1. Install Python from python.org (the macOS installer, not the one that came with the Mac).
2. Open the project folder in Finder and **double-click `Start JARVIS.command`**.
   If macOS says it cannot be opened, right-click it and choose **Open**, then confirm.
   If it still refuses, open Terminal in the folder and run `chmod +x "Start JARVIS.command"`.
3. The first run takes several minutes. Your browser opens at `http://127.0.0.1:8765`.

## Linux

1. Install Python 3.10 to 3.12 with your package manager, for example
   `sudo apt install python3.11 python3.11-venv`.
2. Some Linux systems need two extra system libraries for the camera and the computer's own
   voice:
   ```
   sudo apt install libgl1 espeak-ng
   ```
   `libgl1` is needed for My Hands (the camera). `espeak-ng` is needed only if you use the
   computer's own voice instead of Kokoro (see `docs/LOCAL_VOICE.md`).
3. In a terminal, in the project folder, run `./start_jarvis.sh`.
   The first run takes several minutes. Your browser opens at `http://127.0.0.1:8765`.

## Starting options (all systems)

The starter takes these options. On Windows, add them after `Start JARVIS.bat` in a terminal,
for example `"Start JARVIS.bat" --phone`. On macOS and Linux, use `./start_jarvis.sh --phone`.

| Option | What it does |
|---|---|
| `--check` | Reports what is set up and what is missing, then stops. Changes nothing. |
| `--no-browser` | Starts JARVIS without opening the browser. |
| `--phone` | Lets phones on your home network pair with JARVIS. See "Using a phone" below. |

## Camera and microphone permissions

JARVIS asks your system for permission the first time it uses the camera or microphone.
If you said no, or nothing happened, give permission in the system settings:

- **Windows:** Settings > Privacy & security > Camera, and Settings > Privacy & security >
  Microphone. Turn on **Let desktop apps access your camera / microphone**.
- **macOS:** System Settings > Privacy & Security > Camera, and > Microphone. Tick your browser
  (and Terminal, if you started JARVIS from it).
- **Linux:** check your desktop's privacy settings. Some desktops block the camera by default.

The microphone runs for the wake word ("Hey Jarvis") and for voice. The camera is used only
while My Hands is on, and the preview shows on the glass panel while it is on.

## Firewall

JARVIS listens only on this computer by default. You need to open it to the network only if you
want a phone to pair (`--phone`).

- **Allow it on private networks only.** Never allow JARVIS on public Wi-Fi (cafés, airports,
  hotels). The phone feature is meant for your home network.
- **Windows:** when Windows asks, tick **Private networks** and untick **Public networks**.
- **macOS:** when the firewall asks, allow incoming connections for Python, and only on the
  network you trust.
- **Linux (ufw):** `sudo ufw allow from 192.168.0.0/16 to any port 8765 proto tcp`
  (use your own home network range if it is different).

## Using a phone (pairing)

Pairing is **off by default**. Only `--phone` turns it on, and only for this run.

1. Start JARVIS with `--phone`. The starter shows an address such as
   `http://192.168.1.20:8765/pair`.
2. On the computer, in the JARVIS chat, type **"pair my phone"**. JARVIS asks you to approve it
   on the computer first. Click or type yes.
3. JARVIS shows a **6-digit code** on the computer. It works for **5 minutes** and only once.
4. On the phone, on the same Wi-Fi, open the address from step 1. Type the code.
5. The phone is now paired for **30 days**. You can see your phones with **"list phones"** and
   remove one with **"forget phone 1"** (use its number). A forgotten phone is refused at once.

A paired phone can read the chat and status and send chat messages. It **cannot** use the
camera or microphone, open files, read the memory summary, or change JARVIS itself. Ten phones
at most.

**Letting a phone approve actions.** By default a phone cannot approve or deny the actions JARVIS
asks about. You can give one phone that permission:

1. In the chat on the computer, type **"let phone 1 approve"** (use the phone's number from
   "list phones"). JARVIS asks you first, on the computer. Click or type yes.
2. From then on, that phone can approve or deny those requests, and the chat says which phone
   approved. It still cannot add or remove phones, so a phone cannot let another device in.
3. To take the permission back, type **"stop phone 1 approving"**. No approval is needed for this.
   "list phones" shows which phones can approve.

The phone page and approving from a phone have not been tested on real phones yet. Tell the owner if something looks wrong.

## Troubleshooting

- **"JARVIS needs Python 3.10 to 3.12."** Install a supported Python and run the starter again.
- **`libGL.so.1` missing (Linux).** Run `sudo apt install libgl1`, then start again.
- **The install stopped partway.** Run the starter again. It picks up where it left off.
- **Something is wrong after an update.** Run the starter with `--check`, then start it again.
  The starter installs the packages again whenever the package lists change.
- **The old `run.sh` file.** It has a fixed path from an older computer and is kept only for
  reference. Use the starter files above instead.

## Tested and not tested

- Linux: the starter was run end to end (install, start, health check, phone pairing) in the
  build environment.
- Windows and macOS: the starter files are written but **were not run** in the build environment.
  They have been checked for syntax only. Please report any problem.
- Installer packages (`.exe`, `.dmg`) are not made yet. They need code-signing certificates,
  which this project does not have.
