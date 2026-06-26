#pragma once

#include <iostream>
#include <ostream>
#include <fstream>
#include <string>
#include <cstdio>
#include <ctime>

#include "../myUtil.h"

#define check_negerror(__x, __msg) do { \
    if ((erreur.code = __x) < 0) { \
        erreur.errorStatus = true; \
        erreur.message = (__msg); \
        std::cerr << "[" << jc_utility::now_timestamp() << "] " << erreur.message << std::endl; \
        jc_utility::append_error_log(erreur.path, erreur.code, erreur.message); \
        goto err; \
    } \
    else {erreur.code = 0;}\
} while(0)

#define check_zeroerror(__x, __msg) do {\
    if ((erreur.code = __x) == 0) {\
        erreur.errorStatus = true;\
        erreur.message = (__msg);\
        std::cerr << "[" << jc_utility::now_timestamp() << "] " << erreur.message << std::endl;\
        jc_utility::append_error_log(erreur.path, erreur.code, erreur.message);\
        goto err;\
    }\
    else {erreur.code = 0;}\
} while(0)

#define check_negzeroerror(__x, __msg) do { \
    if ((erreur.code = __x) <= 0) { \
        erreur.errorStatus = true; \
        erreur.message = (__msg); \
        std::cerr << "[" << jc_utility::now_timestamp() << "] " << erreur.message << std::endl; \
        jc_utility::append_error_log(erreur.path, erreur.code, erreur.message); \
        goto err; \
    } \
    else {erreur.code = 0;}\
} while(0)

#define check_negzerror_ret(__x, __msg) do { \
    if ((erreur.code = __x) <= 0) { \
        erreur.errorStatus = true; \
        erreur.message = (__msg); \
        std::cerr << "[" << jc_utility::now_timestamp() << "] " << erreur.message << std::endl; \
        jc_utility::append_error_log(erreur.path, erreur.code, erreur.message); \
        return erreur.code; \
    } \
    else {erreur.code = 0;}\
} while(0)

#define check_negerror_(__x) do { \
    if ((erreur.code = __x) < 0) { \
        erreur.errorStatus = true; \
        erreur.message = "Error code: " + std::to_string(__x); \
        std::cerr << "[" << jc_utility::now_timestamp() << "] " << erreur.message << std::endl; \
        jc_utility::append_error_log(erreur.path, erreur.code, erreur.message); \
        goto err; \
    } \
    else {erreur.code = 0;}\
} while(0)

#define set_error(__x, __msg) do { \
    erreur.code = (__x); \
    erreur.errorStatus = true; \
    erreur.message = (__msg); \
    std::cerr << "[" << jc_utility::now_timestamp() << "] " << erreur.message << std::endl; \
    jc_utility::append_error_log(erreur.path, erreur.code, erreur.message); \
    goto err; \
} while(0)

#define set_error_(__x) do { \
    erreur.code = (__x); \
    erreur.errorStatus = true; \
    erreur.message = "Error code: " + std::to_string(__x); \
    std::cerr << "[" << jc_utility::now_timestamp() << "] " << erreur.message << std::endl; \
    jc_utility::append_error_log(erreur.path, erreur.code, erreur.message); \
    goto err; \
} while(0)

namespace jc_error
{
	class error
	{
	public :
		error() { this->path = "errorLog.txt"; this->errorStatus = 0; this->code = 0; };
		~error() {};
		bool errorStatus;
		std::string message;
		int code;
		std::string path;
		std::tm* dateAndTime;
	
		void printErrorLog();

	private:
	protected:
	};

	extern error erreur;
}

using jc_error::erreur;


