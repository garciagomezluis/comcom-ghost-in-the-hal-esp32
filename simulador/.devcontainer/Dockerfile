FROM node:22-bookworm

# Acceso al puerto serie (/dev/ttyUSB* o /dev/ttyACM*) sin ser root
RUN usermod -aG dialout node

USER node
WORKDIR /workspaces/simulador
