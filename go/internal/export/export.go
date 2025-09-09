package export

import (
	"bolthelper/internal/common"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"go.etcd.io/bbolt"
)

type Row struct {
	Path        []string `json:"path"`
	KeyBase64   string   `json:"keyBase64"`
	ValueBase64 string   `json:"valueBase64"`
}

type Result struct {
	Ok      bool   `json:"ok"`
	Written string `json:"written"`
}

func Run() {
	var dbPath, bucketPath, out, prefix string
	flag.StringVar(&dbPath, "db", "", "DB path")
	flag.StringVar(&bucketPath, "path", "", "bucket path (slash-separated)")
	flag.StringVar(&out, "out", "", "output file")
	flag.StringVar(&prefix, "prefix", "", "prefix filter")
	flag.Parse()
	if dbPath == "" || out == "" {
		fmt.Fprintln(os.Stderr, "missing required args")
		os.Exit(1)
	}
	var path []string
	if bucketPath != "" {
		path = strings.Split(bucketPath, "/")
	}
	db, err := common.OpenDB(dbPath)
	if err != nil {
		common.Fail("open db", err)
	}
	defer db.Close()
	f, err := os.Create(out)
	if err != nil {
		common.Fail("create out", err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	db.View(func(tx *bbolt.Tx) error {
		var b *bbolt.Bucket
		if len(path) > 0 {
			b = common.BucketAtPath(tx, path)
			if b == nil {
				return fmt.Errorf("bucket not found")
			}
		} else {
			b = tx.Cursor().Bucket()
		}
		c := b.Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			if prefix != "" && !strings.HasPrefix(string(k), prefix) {
				continue
			}
			row := Row{path, base64.StdEncoding.EncodeToString(k), base64.StdEncoding.EncodeToString(v)}
			if err := enc.Encode(row); err != nil {
				return err
			}
		}
		return nil
	})
	res := Result{true, out}
	json.NewEncoder(os.Stdout).Encode(res)
}
