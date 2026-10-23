/* Build-time adapter: inspect, or clean synthesized Finder metadata in our image. */
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include "hfs/hfslib.h"

char endianness;

static unsigned finder_records(Volume *volume, HFSCatalogNodeID directory, int clean) {
    unsigned count = 0;
    const unsigned char zero[16] = {0};
    CatalogRecordList *records = getFolderContents(directory, volume);
    for (CatalogRecordList *entry = records; entry; entry = entry->next) {
        if (entry->record->recordType == kHFSPlusFolderRecord) {
            HFSPlusCatalogFolder *folder = (HFSPlusCatalogFolder *)entry->record;
            count += finder_records(volume, folder->folderID, clean);
        } else if (entry->record->recordType == kHFSPlusFileRecord) {
            HFSPlusCatalogFile *file = (HFSPlusCatalogFile *)entry->record;
            /* Symbolic links retain their HFS+ slnk/rhap markers. */
            if (!S_ISREG(file->permissions.fileMode)) continue;
            if (memcmp(&file->userInfo, zero, sizeof(file->userInfo)) ||
                    memcmp(&file->finderInfo, zero, sizeof(file->finderInfo))) {
                count++;
                if (clean) {
                    /* Overwrite fixed-size fields in place, without rebuilding the tree. */
                    HFSPlusCatalogKey key = {0};
                    key.parentID = directory;
                    key.nodeName = entry->name;
                    key.keyLength = 6 + key.nodeName.length * 2;
                    int exact = 0, record_number = 0;
                    uint32_t node_number = 0;
                    HFSPlusCatalogRecord *record = search(volume->catalogTree, (BTKey *)&key,
                                                         &exact, &node_number, &record_number);
                    if (!exact || !record || record->recordType != kHFSPlusFileRecord ||
                            ((HFSPlusCatalogFile *)record)->fileID != file->fileID) exit(1);
                    free(record);
                    off_t offset = getRecordOffset(record_number, node_number, volume->catalogTree) + 2 + key.keyLength;
                    unsigned char blank[16] = {0};
                    if (!WRITE(volume->catalogTree->io, offset + offsetof(HFSPlusCatalogFile, userInfo), sizeof(file->userInfo), blank) ||
                        !WRITE(volume->catalogTree->io, offset + offsetof(HFSPlusCatalogFile, finderInfo), sizeof(file->finderInfo), blank)) exit(1);
                }
            }
        }
    }
    releaseCatalogRecordList(records);
    return count;
}

int main(int argc, char **argv) {
    if (argc != 2 && (argc != 3 || strcmp(argv[2], "--clean-finder-info"))) return 2;
    uint16_t word = 1;
    endianness = *(char *)&word ? IS_LITTLE_ENDIAN : IS_BIG_ENDIAN;
    io_func *io = argc == 3 ? openFlatFile(argv[1]) : openFlatFileRO(argv[1]);
    if (!io) return 1;
    Volume *volume = openVolume(io);
    if (!volume) { CLOSE(io); return 1; }
    unsigned records = finder_records(volume, 2, argc == 3);
    HFSPlusCatalogRecord *folder = getRecordFromPath("/.background", volume, NULL, NULL);
    HFSPlusCatalogRecord *file = getRecordFromPath("/.background/background.png", volume, NULL, NULL);
    int valid = folder && file && folder->recordType == kHFSPlusFolderRecord && file->recordType == kHFSPlusFileRecord;
    if (valid) {
        HFSPlusCatalogFolder *parent = (HFSPlusCatalogFolder *)folder;
        HFSPlusCatalogFile *image = (HFSPlusCatalogFile *)file;
        printf("{\"volume_created\":%u,\"folder_id\":%u,\"file_id\":%u,\"file_created\":%u,\"finder_records\":%u}\n",
               volume->volumeHeader->createDate, parent->folderID, image->fileID, image->createDate, records);
    }
    free(folder); free(file); closeVolume(volume); CLOSE(io);
    return valid ? 0 : 1;
}
