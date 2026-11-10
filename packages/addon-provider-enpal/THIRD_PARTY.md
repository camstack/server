# Third-party notices

## derolli1976/enpal (Home Assistant component "Enpal Solar")

`python/enpal_blazor/protocol.py` and `python/enpal_blazor/render_batch.py` are copied
unchanged from `custom_components/enpal_webparser/api/` of
[derolli1976/enpal](https://github.com/derolli1976/enpal) (MIT License): the Blazor
Server SignalR framing and the RenderBatch decoder that read a box running firmware 8.5x.
The Home Assistant layer is not included. The connection sequence in
`python/enpal_worker.py` follows that component's `websocket_client.py`.

See `python/enpal_blazor/LICENSE` for the full license text.
