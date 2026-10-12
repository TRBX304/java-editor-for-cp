# ローカルジャッジ(Java)

JS版ローカルジャッジのJava版。WindowsのNode.jsから、Windowsに入れたJDKの `javac` / `java` を直接呼ぶ(WSLは使わない)。
画面は http://localhost:2436(JS版の2434、C/C++版の2435と同時に起動できる)。

## 必要なもの

- Node.js 18以上(JS版で使っているもの)
- JDK(`javac` が必要。JREだけでは動かない)
  - コマンドプロンプトで `javac -version` が通ればOK
  - 通らなければ、JDKの `bin` フォルダを PATH に追加するか、`JAVA_HOME` を設定する

## 起動

`start.bat` をダブルクリック。起動ログに java / javac のバージョンが出る。

## JS版から増えたもの

- コンパイル段階と **CE** 判定。javac のエラーはテストケース欄の上に表示
- 同じコードを再実行するときはコンパイルを省略
- REのとき、例外の種類(ArrayIndexOutOfBoundsException など)にひとこと説明を表示
- スタックを512MBに広げて実行(深い再帰でも StackOverflowError になりにくい)
- 実行オプション: `-Xss512m -Xmx1024m -XX:+UseSerialGC`、入出力はすべてUTF-8

## 注意

- クラス名は `Main`(AtCoderと同じ)
- 実行時間にはJVMの起動時間(数十〜百ms程度)が含まれる。AtCoderでも同様
