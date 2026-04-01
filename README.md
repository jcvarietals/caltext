# CalText

A Chrome extension for Google Calendar that lets you click and drag to select time blocks and then copy them as text.

Sharing availability means opening your calendar, scanning the week, and carefully typing out time slots. It's slow, error-prone, and easy to get the wrong day or forget the timezone.

**CalText:** Turn on selection mode, drag over the times you're free and copy. 
<img width="1209" height="510" alt="Use CalText in Week view" src="https://github.com/user-attachments/assets/3f410dc6-9998-44ad-b370-4d4c7af9f76d" />


---

## Install

CalText is not yet on the Chrome Web Store. To install:

1. Download or clone this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `caltext-main` folder
5. Navigate to [Google Calendar](https://calendar.google.com) in week view

---

## How to use

1. Open Google Calendar in **week view**
2. Click the **CT tab** on the right edge of the screen to open the panel
3. Click **Selection Mode: OFF** to turn it on
4. Click and drag on any time slot to select it — it highlights blue
5. Drag over an existing highlight to **remove** part of it
6. Navigate between weeks freely — selections persist across weeks
7. Click **Copy** to copy the formatted list to your clipboard

**Output looks like:**
```
• Mon, Mar 31 at 10:00 AM – 11:30 AM PDT
• Wed, Apr 2 at 2:00 PM – 3:00 PM PDT
```

---

## Settings

| Setting | Description |
|---|---|
| **Date/time format** | Customize how dates appear in the output (see format tokens below) |
| **Highlight color & opacity** | Change the color and transparency of selected blocks |
| **Time snap increment** | Snap selections to 15 or 30 minute boundaries |
| **Output format** | Toggle between bullet points (•) or plain lines |

### Format tokens

Wrap any literal text in `[brackets]` to prevent it from being parsed as a token.

| Token | Output |
|---|---|
| `ddd` | Mon, Tue, Wed |
| `dddd` | Monday, Tuesday |
| `MMM` | Jan, Feb, Mar |
| `MMMM` | January, February |
| `M` / `MM` | 3 / 03 |
| `D` / `DD` | 5 / 05 |
| `YYYY` / `YY` | 2026 / 26 |
| `h` / `hh` | 1–12 (no pad / padded) |
| `H` / `HH` | 0–23 (no pad / padded) |
| `mm` | 00–59 (minutes) |
| `A` / `a` | AM/PM / am/pm |

**Default:** `ddd, MMM D [at] h:mm A`
**Example output:** `Mon, Mar 31 at 10:00 AM`

---

## Notes

- Everything runs locally in your browser. No data is ever sent anywhere.
- Selections clear on page refresh; settings persist
- Only works in Google Calendar week view
