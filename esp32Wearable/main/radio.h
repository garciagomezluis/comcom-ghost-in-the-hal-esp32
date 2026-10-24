#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

#define RADIO_MAX_PAYLOAD 32

typedef struct {
    uint8_t from[6];
    uint8_t len;
    uint8_t data[RADIO_MAX_PAYLOAD];
} radio_packet_t;

esp_err_t radio_init(void);

esp_err_t radio_send(const void *data, size_t len);

QueueHandle_t radio_queue(void);