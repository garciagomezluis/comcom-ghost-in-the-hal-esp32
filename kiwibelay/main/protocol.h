#pragma once

// Copia del protocol.h de la placa B. Diferencia: sacamos el enum command_type_t
// porque sus nombres (CMD_TENSION...) chocan con ab_cmd_t de autobelayer.h.
// Los valores son los mismos (1=TENSION 2=BAJAME 3=SIGO 4=AYUDA), así que
// commandType se usa directo como ab_cmd_t. Los structs no cambian.

#include <stdint.h>

#define REMOTE_DEVICE_ID 2u
#define GROUND_DEVICE_ID 1u

typedef enum {
    STATUS_NORMAL = 0,
    STATUS_ALERT = 1,
} status_event_t;

typedef struct __attribute__((packed)) {
    uint8_t senderId;
    uint8_t commandType;
    uint32_t timestamp;
} CommandMessage;

typedef struct __attribute__((packed)) {
    char statusText[24];
    float tensionReading;
    uint8_t eventFlag;
} StatusMessage;

_Static_assert(
    sizeof(CommandMessage) == 6,
    "CommandMessage size is not 6 bytes"
);

_Static_assert(
    sizeof(StatusMessage) == 29,
    "StatusMessage size is not 29 bytes"
);