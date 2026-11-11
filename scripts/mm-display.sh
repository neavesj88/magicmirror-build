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
#   mm-display.sh status   current power state and schedule
#
# The default hours are the repo's config/display.conf, deployed to
# ~/.config/mm-display.conf. The "Screen-off Times" desktop icon writes
# ~/.config/mm-display.local.conf, read last so it wins, and never touched by
# the update.

NIGHT_OFF=1
OFF_AT="23:00"
ON_AT="05:00"
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

# 0x01 = on; 0x02 (standby) and 0x04 (off) both mean dark. Empty = no answer.
power_state() { ddcutil getvcp D6 2>/dev/null | grep -o 'sl=0x[0-9a-fA-F]*' | cut -d= -f2; }
panel_on()  { ddcutil setvcp D6 01 >/dev/null 2>&1; }
panel_off() { ddcutil setvcp D6 04 >/dev/null 2>&1; }

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
        fi
        ;;
    off) panel_off && rm -f "$MARK" "$HOLD" && log "off by hand" ;;
    on)
        panel_on || { echo "Display board not answering" >&2; exit 1; }
        rm -f "$MARK"
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
        ;;
    *) echo "Usage: $0 auto|on|off|status" >&2; exit 2 ;;
esac
