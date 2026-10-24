idf_component_register(
    SRCS "main.c" "display.c" "buttons.c" "radio.c" "autobelayer.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_lcd esp_driver_spi esp_driver_gpio
                  esp_wifi esp_netif esp_event nvs_flash
                  esp_driver_usb_serial_jtag
)
