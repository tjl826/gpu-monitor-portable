# Portable GPU Monitor

Track NVIDIA GPUs on a Linux server from a browser. The monitor samples each GPU every five minutes and keeps the last 72 hours in a local CSV file. The dashboard shows each GPU's power draw, utilization, memory use, and temperature. Switch between 1-hour, 6-hour, 24-hour, and 72-hour views to compare power, utilization, and memory trends across GPUs.

## Install on the GPU server

Use a regular Linux account with Python 3.7 or later and a working NVIDIA driver. Run `nvidia-smi --list-gpus` to check that the account can see the GPUs. The application uses the Python standard library and includes its web assets.

Download `gpu-monitor-portable-20261124.tar.gz` and its matching `.sha256` file. Both files are available under [GitHub Releases](https://github.com/tjl826/gpu-monitor-portable/releases).

Place both files in a persistent directory you own on the GPU server. From that directory, verify the download, extract the archive, and start the monitor.

```sh
sha256sum -c gpu-monitor-portable-20261124.tar.gz.sha256
tar -xzf gpu-monitor-portable-20261124.tar.gz
cd gpu-monitor-portable-20261124
python3 install_server.py --autostart
```

The installer starts the monitor on `127.0.0.1:18770`. With `--autostart`, it adds entries to your user's crontab to start the monitor at boot and check it every minute. This option requires the `crontab` command and a running cron service. For a manual start without cron, use `python3 install_server.py`.

Keep the extracted directory in place. The monitor writes its data and logs there, and the generated launcher records the installation path.

## Open the dashboard

On your viewing computer, replace `user@gpu-server` with your usual SSH destination to open a tunnel.

```sh
ssh -NT -L 18770:127.0.0.1:18770 user@gpu-server
```

Leave the terminal open and visit [http://127.0.0.1:18770](http://127.0.0.1:18770). The first sample is taken at startup. Closing the tunnel disconnects the browser while collection continues on the server.

If the port on your viewing computer is busy, change the first port in the tunnel command to `18771` and open `http://127.0.0.1:18771`. The final port must match the monitor's port on the server.

## Manage the monitor

Use the launcher in the installation directory on the server.

```sh
./gpu-monitor.sh status
./gpu-monitor.sh stop       # Pause collection and automatic restarts
./gpu-monitor.sh start      # Resume collection
tail -n 30 monitor.log
```

To change the server port, stop the monitor and rerun the installer with the new port, for example `python3 install_server.py --port 18771 --autostart`. For direct access on a trusted network, the installer also accepts `--host`. The HTTP service has no authentication, so anyone who can reach its port can read the metrics.

To uninstall, stop the monitor. If you enabled autostart, run `crontab -e` and remove the three lines marked for this installation (the directory comment and its two scheduled commands). Save a copy of `gpu_metrics.csv` if you want to keep the history, then remove the installation directory.

## Data and API

Each CSV row describes one GPU at one sampling instant. Brief spikes can fall between samples. Unsupported metrics appear as blank CSV cells and JSON `null` values. A failed collection adds no rows. The dashboard uses your browser's local time zone. The CSV includes Unix time in `timestamp` and a fixed UTC+08:00 offset in `timestamp_iso`.

| Endpoint | Response |
| --- | --- |
| `/api/data?hours=6` | JSON with the latest readings, sampling status, and history for the requested window |
| `/api/export.csv?hours=72` | Downloadable CSV with one row per GPU per sample for the requested window |

Both endpoints accept a fractional or whole number of hours greater than zero and up to 72. The default is 72 hours. Export the CSV before older samples expire if you need a longer record.

## Run the tests

The tests use simulated GPU readings and a local HTTP server. Run them from the project directory.

```sh
python3 -m unittest -v test_monitor
```
