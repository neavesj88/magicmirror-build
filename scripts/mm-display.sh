#!/bin/bash
# mm-display.sh - switch the display board on or off over DDC/CI.
#
# An LCD's backlight lights the whole panel, and through two-way acrylic even
# a pure-black page shows as a grey rectangle. Powering the board down is the
# only way to get a clean mirror, so overnight it goes into standby.
#
#   mm-display.sh auto     what cron runs every 5 min: off in the quiet hours,
#                          back on afterwards if the schedule turned it off
#   mm-display.sh off|on   by hand
#   mm-display.sh status   current power state, schedule and picture settings
#
# While the panel is on, auto also holds the board's picture settings
# (BRIGHTNESS, CONTRAST, GAIN) at the configured values. A setting changed
# with ddcutil can be lost when the board loses power, so it is put back
# rather than trusted to stick.
#
# The default hours are the repo's config/display.conf, deployed to
# ~/.config/mm-display.conf. The "Screen-off Times" desktop icon writes
# ~/.config/mm-display.local.conf, read last so it wins, and never touched by
# the update.

NIGHT_OFF=1
OFF_AT="23:00"
ON_AT="05:00"
# 0-100 each; blank leaves the board's own value alone. GAIN sets red, green
# and blue together.
BRIGHTNESS=""
CONTRAST=""
GAIN=""
CONF="$HOME/.config/mm-display.conf"
LOCAL="$HOME/.config/mm-display.local.conf"
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"
# shellcheck source=/dev/null
[ -f "$LOCAL" ] && . "$LOCAL"

# Present only while the schedule is what turned the panel off, so the morning
# undoes its own work and never a deliberate off made some other way (by hand
# now, the presence sensor later).
MARK="$HOME/.cache/mm-display.night-off"
# Set by `on` during the quiet hours, so a manual wake at 01:00 isn't undone by
# the next 5-minute check. Cleared once the quiet hours end.
HOLD="$HOME/.cache/mm-display.hold"
LOG="$HOME/mm-display.log"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# A bad value in the config logs every 5 min; don't let that eat the eMMC.
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 200000 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# 0x01 = on; 0x02 (standby) and 0x04 (off) both mean dark. Empty = no answer.
power_state() { ddcutil getvcp D6 2>/dev/null | grep -o 'sl=0x[0-9a-fA-F]*' | cut -d= -f2; }
panel_on()  { ddcutil setvcp D6 01 >/dev/null 2>&1; }
panel_off() { ddcutil setvcp D6 04 >/dev/null 2>&1; }

vcp_value() { ddcutil getvcp "$1" 2>/dev/null | grep -oE 'current value = *[0-9]+' | grep -oE '[0-9]+$'; }

# Writes only when the board differs, so the 5-minute check is read-only
# almost always, and every real change is logged.
hold_vcp() {
    local code=$1 want=$2 name=$3 cur
    [ -n "$want" ] || return 0
    if ! [[ $want =~ ^[0-9]+$ ]] || [ "$want" -gt 100 ]; then
        log "picture: $name=\"$want\" is not 0-100, ignored"; return 0
    fi
    cur=$(vcp_value "$code")
    [ -z "$cur" ] || [ "$cur" = "$want" ] && return 0
    if ddcutil setvcp "$code" "$want" >/dev/null 2>&1; then
        log "picture: $name $cur -> $want"
    else
        log "picture: setting $name FAILED"
    fi
}

hold_picture() {
    hold_vcp 10 "$BRIGHTNESS" brightness
    hold_vcp 12 "$CONTRAST" contrast
    hold_vcp 16 "$GAIN" "red gain"
    hold_vcp 18 "$GAIN" "green gain"
    hold_vcp 1A "$GAIN" "blue gain"
}

to_min() { local h=${1%%:*} m=${1##*:}; echo $((10#$h * 60 + 10#$m)); }

in_quiet_hours() {
    local now start end
    now=$(to_min "$(date +%H:%M)")
    start=$(to_min "$OFF_AT")
    end=$(to_min "$ON_AT")
    [ "$start" -eq "$end" ] && return 1
    if [ "$start" -lt "$end" ]; then
        [ "$now" -ge "$start" ] && [ "$now" -lt "$end" ]
    else
        [ "$now" -ge "$start" ] || [ "$now" -lt "$end" ]
    fi
}

case "${1:-}" in
    auto)
        # Re-checked every 5 min rather than fired once at 23:00, so a reboot
        # or power cut in the night (the board comes back on) is put right.
        if [ "$NIGHT_OFF" = "1" ] && in_quiet_hours; then
            [ -f "$HOLD" ] && exit 0
            state=$(power_state)
            if [ -z "$state" ]; then log "night: display board not answering"; exit 1; fi
            mkdir -p "$(dirname "$MARK")"
            if [ "$state" = "0x01" ]; then
                if panel_off; then log "night: panel off"; else log "night: off FAILED"; exit 1; fi
            fi
            touch "$MARK"
        else
            rm -f "$HOLD"
            if [ -f "$MARK" ]; then
                # The mark stays until the wake succeeds, so a failure retries.
                if panel_on; then rm -f "$MARK"; log "morning: panel on"; else log "morning: on FAILED"; exit 1; fi
            fi
            # Only while it is on: a write to a board in standby may wake it.
            [ "$(power_state)" = "0x01" ] && hold_picture
        fi
        ;;
    off) panel_off && rm -f "$MARK" "$HOLD" && log "off by hand" ;;
    on)
        panel_on || { echo "Display board not answering" >&2; exit 1; }
        rm -f "$MARK"
        hold_picture
        if [ "$NIGHT_OFF" = "1" ] && in_quiet_hours; then
            mkdir -p "$(dirname "$HOLD")"; touch "$HOLD"
            log "on by hand, held until $ON_AT"
        else
            log "on by hand"
        fi
        ;;
    status)
        case "$(power_state)" in
            0x01) echo "Panel: on" ;;
            "")   echo "Panel: not answering on DDC" ;;
            *)    echo "Panel: off (standby)" ;;
        esac
        if [ "$NIGHT_OFF" = "1" ]; then echo "Night off: $OFF_AT to $ON_AT"; else echo "Night off: disabled"; fi
        if [ -f "$LOCAL" ]; then echo "Times set on the mirror ($LOCAL)"; else echo "Times from the repo"; fi
        echo "Picture: brightness $(vcp_value 10)/${BRIGHTNESS:-board}, contrast $(vcp_value 12)/${CONTRAST:-board}, gain $(vcp_value 16)/${GAIN:-board} (now/held)"
        ;;
    *) echo "Usage: $0 auto|on|off|status" >&2; exit 2 ;;
esac
