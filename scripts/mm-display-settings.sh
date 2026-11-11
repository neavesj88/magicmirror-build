#!/bin/bash
# mm-display-settings.sh - the "Screen-off Times" desktop icon: a small form
# for changing the overnight screen-off hours on the mirror itself.
#
# Writes ~/.config/mm-display.local.conf, which mm-display.sh reads after the
# repo defaults. The nightly update never touches that file, so a time set
# here survives; picking the repo's own values again deletes it.

DEFAULTS="$HOME/.config/mm-display.conf"
LOCAL="$HOME/.config/mm-display.local.conf"
TITLE="Screen-off Times"

NIGHT_OFF=1; OFF_AT="23:00"; ON_AT="05:00"
# shellcheck source=/dev/null
[ -f "$DEFAULTS" ] && . "$DEFAULTS"
D_NIGHT_OFF=$NIGHT_OFF; D_OFF_AT=$OFF_AT; D_ON_AT=$ON_AT
# shellcheck source=/dev/null
[ -f "$LOCAL" ] && . "$LOCAL"

# Half-hour steps, with the current value listed first so it is the one shown
# (and kept) when the field is left alone.
times() {
    local cur=$1 h m
    echo -n "$cur"
    for h in $(seq -w 0 23); do
        for m in 00 30; do [ "$h:$m" = "$cur" ] || echo -n "|$h:$m"; done
    done
}
[ "$NIGHT_OFF" = "1" ] && ENABLED="On|Off" || ENABLED="Off|On"

RESULT=$(zenity --forms --title="$TITLE" \
    --text="Mirror screen switches off overnight.\nNow: off $OFF_AT, on $ON_AT ($( [ "$NIGHT_OFF" = 1 ] && echo enabled || echo disabled ))." \
    --add-combo="Screen off at" --combo-values="$(times "$OFF_AT")" \
    --add-combo="Screen on at" --combo-values="$(times "$ON_AT")" \
    --add-combo="Night screen-off" --combo-values="$ENABLED" \
    --separator="|" 2>/dev/null) || exit 0

IFS='|' read -r NEW_OFF NEW_ON NEW_EN <<< "$RESULT"
# An untouched combo can come back empty: keep what was there.
NEW_OFF=${NEW_OFF:-$OFF_AT}
NEW_ON=${NEW_ON:-$ON_AT}
case "${NEW_EN:-}" in On) NEW_EN=1 ;; Off) NEW_EN=0 ;; *) NEW_EN=$NIGHT_OFF ;; esac

valid() { [[ $1 =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; }
if ! valid "$NEW_OFF" || ! valid "$NEW_ON"; then
    zenity --error --title="$TITLE" --text="Times must be HH:MM (24 h). Nothing changed." 2>/dev/null
    exit 1
fi
if [ "$NEW_EN" = "1" ] && [ "$NEW_OFF" = "$NEW_ON" ]; then
    zenity --error --title="$TITLE" --text="Off and on are both $NEW_OFF, which would never switch off.\nNothing changed." 2>/dev/null
    exit 1
fi

if [ "$NEW_EN" = "$D_NIGHT_OFF" ] && [ "$NEW_OFF" = "$D_OFF_AT" ] && [ "$NEW_ON" = "$D_ON_AT" ]; then
    rm -f "$LOCAL"
    WHERE="Back to the repo's default times."
else
    mkdir -p "$(dirname "$LOCAL")"
    printf '# Set from the desktop on %s. Delete this file to go back to the repo times.\nNIGHT_OFF=%s\nOFF_AT="%s"\nON_AT="%s"\n' \
        "$(date '+%F %H:%M')" "$NEW_EN" "$NEW_OFF" "$NEW_ON" > "$LOCAL.tmp" && mv "$LOCAL.tmp" "$LOCAL"
    WHERE="Saved on this mirror; updates won't change it."
fi
echo "$(date '+%F %T') times set from desktop: off $NEW_OFF, on $NEW_ON, enabled $NEW_EN" >> "$HOME/mm-display.log"

if [ "$NEW_EN" = "1" ]; then
    MSG="Screen off at $NEW_OFF, back on at $NEW_ON.\n$WHERE\nTakes effect within 5 minutes."
else
    MSG="Night screen-off is disabled.\n$WHERE"
fi
zenity --info --title="$TITLE" --text="$MSG" 2>/dev/null
