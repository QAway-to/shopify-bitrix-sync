package com.example.mvpapp.data.repository

import com.example.mvpapp.data.model.DataItem
import kotlinx.coroutines.delay

class DataRepository {

    suspend fun getItems(): List<DataItem> {
        // Simulate network delay
        delay(1000)
        
        // Return mock data
        return listOf(
            DataItem(
                id = "1",
                title = "Sample Item 1",
                description = "This is a sample description for item 1",
                timestamp = System.currentTimeMillis() - 86400000
            ),
            DataItem(
                id = "2",
                title = "Sample Item 2",
                description = "This is a sample description for item 2",
                timestamp = System.currentTimeMillis() - 43200000
            ),
            DataItem(
                id = "3",
                title = "Sample Item 3",
                description = "This is a sample description for item 3",
                timestamp = System.currentTimeMillis() - 21600000
            ),
            DataItem(
                id = "4",
                title = "Sample Item 4",
                description = "This is a sample description for item 4",
                timestamp = System.currentTimeMillis() - 10800000
            ),
            DataItem(
                id = "5",
                title = "Sample Item 5",
                description = "This is a sample description for item 5",
                timestamp = System.currentTimeMillis()
            )
        )
    }
}













