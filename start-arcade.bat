@echo off
title ROMS Arcade Multiplayer Server
cd /d "%~dp0"
if not exist node_modules npm.cmd install --cache .npm-cache
npm.cmd run start
