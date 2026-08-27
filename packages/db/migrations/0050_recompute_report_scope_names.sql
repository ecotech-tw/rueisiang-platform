-- 0049 的回填只移除了一部分 ASCII 空白，會讓全形空白造成同一據點被拆成兩個 scope。
-- 這裡用 SQLite 可用的字元清單重算，對齊 normalizeReportScopeName 的 trim、\s+ 移除與小寫規則。
UPDATE report_scopes
SET normalized_name = lower(
  replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(
                            replace(
                              replace(
                                replace(
                                  replace(
                                    replace(
                                      replace(
                                        replace(
                                          replace(
                                            replace(
                                              replace(
                                                replace(
                                                  replace(
                                                    replace(
                                                      replace(name, char(9), ''),
                                                      char(10), ''
                                                    ),
                                                    char(11), ''
                                                  ),
                                                  char(12), ''
                                                ),
                                                char(13), ''
                                              ),
                                              char(32), ''
                                            ),
                                            char(160), ''
                                          ),
                                          char(5760), ''
                                        ),
                                        char(8192), ''
                                      ),
                                      char(8193), ''
                                    ),
                                    char(8194), ''
                                  ),
                                  char(8195), ''
                                ),
                                char(8196), ''
                              ),
                              char(8197), ''
                            ),
                            char(8198), ''
                          ),
                          char(8199), ''
                        ),
                        char(8200), ''
                      ),
                      char(8201), ''
                    ),
                    char(8202), ''
                  ),
                  char(8232), ''
                ),
                char(8233), ''
              ),
              char(8239), ''
            ),
            char(8287), ''
          ),
          char(12288), ''
        ),
        char(65279), ''
      )
);
