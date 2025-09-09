package main

import (
	"bolthelper/internal/common"
	"bolthelper/internal/export"
	"bolthelper/internal/get"
	"bolthelper/internal/listkeys"
	"bolthelper/internal/search"
	"flag"
	"fmt"
	"os"
	"strings"

	"go.etcd.io/bbolt"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "missing subcommand")
		os.Exit(1)
	}
	sub := os.Args[1]
	os.Args = append([]string{os.Args[0]}, os.Args[2:]...)
	switch sub {
	case "meta":
		var dbPath string
		flag.StringVar(&dbPath, "db", "", "DB path")
		flag.Parse()
		db, err := common.OpenDB(dbPath)
		if err != nil {
			common.Fail("open db", err)
		}
		defer db.Close()
		res := common.CmdMeta(db)
		common.PrintJSON(res)
	case "lsb":
		var dbPath, bucketPath string
		flag.StringVar(&dbPath, "db", "", "DB path")
		flag.StringVar(&bucketPath, "path", "", "bucket path (slash-separated)")
		flag.Parse()
		db, err := common.OpenDB(dbPath)
		if err != nil {
			common.Fail("open db", err)
		}
		defer db.Close()
		db.View(func(tx *bbolt.Tx) error {
			var path []string
			if bucketPath != "" {
				path = strings.Split(bucketPath, "/")
			}
			res := common.CmdListBuckets(tx, path)
			common.PrintJSON(res)
			return nil
		})
	case "lsk":
		listkeys.Run()
	case "get":
		get.Run()
	case "export":
		export.Run()
	case "search":
		search.Run()
	default:
		fmt.Fprintln(os.Stderr, "unknown subcommand")
		os.Exit(1)
	}
}
