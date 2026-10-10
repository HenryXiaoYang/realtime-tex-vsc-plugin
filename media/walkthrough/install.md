# Installing rtex

**Install rtex** downloads the prebuilt engine of the latest [realtime-tex release](https://github.com/HenryXiaoYang/realtime-tex/releases) for your platform (Linux, macOS or Windows; a few MB), checks its SHA-256 and unpacks it into VS Code's extension storage. The extension then finds it by itself, so you don't need to change any settings.

**Build from source instead:** **Realtime TeX: Install rtex (Build from Source)** clones `realtime-tex` `main` and runs

```
cargo build --release -p rtex-cli
```

in a terminal you can watch (on Windows, in Git Bash). It needs Rust and takes a few minutes. Set **Realtime TeX: Install From** to `source` to make that the default.

Already have rtex? Use **Locate the rtex binary** and select it (`bin/rtex` of a release, `target/release/rtex` of a build; `.exe` on Windows).

**Keeping it current:** the extension checks for a newer rtex once a day and offers to update (a new release, or new commits on `main` for a source build). Run **Realtime TeX: Update rtex Engine** any time, or set **Realtime TeX: Update Check** to `auto` or `off`.
