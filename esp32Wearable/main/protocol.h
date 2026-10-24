#pragma once

#include <stdint.h>

#define REMOTE_DEVICE_ID 2u
#define GROUND_DEVICE_ID 1u

typedef enum {
    CMD_TENSION = 1,
    CMD_BAJAME = 2,
    CMD_SIGO = 3,
    CMD_AYUDA = 4,
} command_type_t;

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