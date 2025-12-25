package com.example.mvpapp.data.model

import android.os.Parcelable
import kotlinx.parcelize.Parcelize

@Parcelize
data class DataItem(
    val id: String,
    val title: String,
    val description: String,
    val timestamp: Long,
    val imageUrl: String? = null
) : Parcelable

